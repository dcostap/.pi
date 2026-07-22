import { CDP } from "./protocol.ts";

export type Locator = {
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  exact?: boolean;
  index?: number;
};

export type LocatorMetadata = {
  tag: string;
  id: string;
  classes: string[];
  role: string | null;
  name: string;
  text: string;
  value?: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
  pageRect: { x: number; y: number; width: number; height: number };
  connected: boolean;
  disabled: boolean;
  editable: boolean;
  visible: boolean;
  pointerEvents: string;
  opacity: string;
  focused: boolean;
};

export type ResolvedLocator = {
  objectId: string;
  backendNodeId: number;
  nodeId?: number;
  metadata: LocatorMetadata;
};

export function hasLocator(locator?: Locator): boolean {
  return !!locator && [locator.selector, locator.role, locator.name, locator.text].some((value) => typeof value === "string" && value.length > 0);
}

export function locatorFromParams(params: Locator): Locator {
  return {
    selector: params.selector,
    role: params.role,
    name: params.name,
    text: params.text,
    exact: params.exact,
    index: params.index,
  };
}

export function describeLocator(locator: Locator): string {
  const parts: string[] = [];
  if (locator.selector) parts.push(`css=${JSON.stringify(locator.selector)}`);
  if (locator.role) parts.push(`role=${JSON.stringify(locator.role)}`);
  if (locator.name) parts.push(`name=${JSON.stringify(locator.name)}`);
  if (locator.text) parts.push(`text=${JSON.stringify(locator.text)}`);
  if (locator.index != null) parts.push(`index=${locator.index}`);
  return parts.join(" ") || "focused element";
}

export function buildLocatorExpression(locator: Locator): string {
  const payload = JSON.stringify({ ...locator, index: Math.max(0, Math.round(locator.index ?? 0)) });
  return `(() => {
    const locator = ${payload};
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const compare = (actual, expected) => {
      actual = normalize(actual); expected = normalize(expected);
      return locator.exact ? actual.toLowerCase() === expected.toLowerCase() : actual.toLowerCase().includes(expected.toLowerCase());
    };
    const implicitRole = (el) => {
      const explicit = el.getAttribute?.('role');
      if (explicit) return explicit.split(/\\s+/)[0].toLowerCase();
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute?.('type') || '').toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        if (['button','submit','reset','image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (!['hidden','file','color'].includes(type)) return 'textbox';
      }
      return '';
    };
    const accessibleName = (el) => {
      const aria = el.getAttribute?.('aria-label');
      if (aria) return normalize(aria);
      const labelledBy = el.getAttribute?.('aria-labelledby');
      if (labelledBy) {
        const root = el.getRootNode?.();
        const labelled = labelledBy.split(/\\s+/).map((id) => root?.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' ');
        if (normalize(labelled)) return normalize(labelled);
      }
      if (el.labels?.length) return normalize([...el.labels].map((label) => label.textContent || '').join(' '));
      if (el.getAttribute?.('alt')) return normalize(el.getAttribute('alt'));
      if (el.getAttribute?.('title')) return normalize(el.getAttribute('title'));
      if (['INPUT','TEXTAREA'].includes(el.tagName) && el.getAttribute?.('placeholder')) return normalize(el.getAttribute('placeholder'));
      return normalize(el.innerText || el.textContent || el.value || '');
    };
    const roots = [document];
    const all = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      for (const el of root.querySelectorAll('*')) {
        all.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    let candidates;
    if (locator.selector) {
      candidates = [];
      for (const root of roots) {
        try { candidates.push(...root.querySelectorAll(locator.selector)); }
        catch (error) { throw new Error('Invalid CSS selector: ' + locator.selector + ' (' + error.message + ')'); }
      }
    } else {
      candidates = all;
    }
    candidates = [...new Set(candidates)];
    if (locator.role) candidates = candidates.filter((el) => compare(implicitRole(el), locator.role));
    if (locator.name) candidates = candidates.filter((el) => compare(accessibleName(el), locator.name));
    if (locator.text) {
      const matchesText = (el) => compare(el.innerText || el.textContent || '', locator.text);
      candidates = candidates.filter(matchesText);
      if (!locator.selector && !locator.role && !locator.name) {
        const smallest = candidates.filter((el) => ![...el.children].some(matchesText));
        if (smallest.length) candidates = smallest;
      }
    }
    return candidates[locator.index] || null;
  })()`;
}

const METADATA_FUNCTION = `function() {
  const el = this;
  const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const tag = String(el.tagName || '').toUpperCase();
  const labelledBy = el.getAttribute?.('aria-labelledby');
  let name = el.getAttribute?.('aria-label') || '';
  if (!name && labelledBy) {
    const root = el.getRootNode?.();
    name = labelledBy.split(/\\s+/).map((id) => root?.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' ');
  }
  if (!name && el.labels?.length) name = [...el.labels].map((label) => label.textContent || '').join(' ');
  if (!name) name = el.getAttribute?.('alt') || el.getAttribute?.('title') || el.innerText || el.textContent || el.value || '';
  const attributes = {};
  for (const attr of el.attributes || []) attributes[attr.name] = attr.value;
  const visible = !!(rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0);
  const inputType = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  const editableInput = tag === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(inputType);
  const editable = editableInput || tag === 'TEXTAREA' || !!el.isContentEditable;
  return {
    tag, id: el.id || '', classes: [...(el.classList || [])].slice(0, 30),
    role: el.getAttribute?.('role') || null, name: normalize(name),
    text: normalize(el.innerText || el.textContent || '').slice(0, 500),
    value: editable ? String(el.value ?? el.textContent ?? '') : undefined,
    attributes, rect: { x:rect.x, y:rect.y, width:rect.width, height:rect.height, top:rect.top, right:rect.right, bottom:rect.bottom, left:rect.left },
    pageRect: { x:rect.x + scrollX, y:rect.y + scrollY, width:rect.width, height:rect.height },
    connected: el.isConnected, disabled: !!el.disabled || el.getAttribute?.('aria-disabled') === 'true',
    editable, visible, pointerEvents:style.pointerEvents, opacity:style.opacity,
    focused: document.activeElement === el || !!el.contains?.(document.activeElement),
  };
}`;

export async function callOnObject<T>(
  cdp: CDP,
  sessionId: string,
  objectId: string,
  functionDeclaration: string,
  options: { arguments?: any[]; awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: options.arguments ?? [],
    awaitPromise: options.awaitPromise ?? true,
    returnByValue: options.returnByValue ?? true,
  }, sessionId, options.timeoutMs ?? 15_000, options.signal);
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.callFunctionOn failed";
    throw new Error(description);
  }
  return (options.returnByValue ?? true) ? result.result?.value as T : result.result as T;
}

export async function readLocatorMetadata(cdp: CDP, sessionId: string, objectId: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<LocatorMetadata> {
  return callOnObject<LocatorMetadata>(cdp, sessionId, objectId, METADATA_FUNCTION, { timeoutMs, signal });
}

export async function resolveLocator(cdp: CDP, sessionId: string, locator: Locator, timeoutMs = 15_000, signal?: AbortSignal): Promise<ResolvedLocator> {
  if (!hasLocator(locator)) throw new Error("Provide selector, role, name, or text to locate an element");
  await cdp.send("Runtime.enable", {}, sessionId, timeoutMs, signal);
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: buildLocatorExpression(locator),
    returnByValue: false,
    awaitPromise: true,
    objectGroup: "pi-chrome-cdp-locators",
  }, sessionId, timeoutMs, signal);
  if (evaluated.exceptionDetails) {
    const description = evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || "Locator evaluation failed";
    throw new Error(description);
  }
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === "null") {
    throw new Error(`No element matched ${describeLocator(locator)}`);
  }
  try {
    const described = await cdp.send("DOM.describeNode", { objectId, depth: 0 }, sessionId, timeoutMs, signal);
    const metadata = await readLocatorMetadata(cdp, sessionId, objectId, timeoutMs, signal);
    return {
      objectId,
      backendNodeId: described.node?.backendNodeId,
      nodeId: described.node?.nodeId || undefined,
      metadata,
    };
  } catch (error) {
    await releaseLocator(cdp, sessionId, objectId).catch(() => {});
    throw error;
  }
}

export async function releaseLocator(cdp: CDP, sessionId: string, objectId: string): Promise<void> {
  await cdp.send("Runtime.releaseObject", { objectId }, sessionId, 1_000).catch(() => {});
}

export async function withResolvedLocator<T>(
  cdp: CDP,
  sessionId: string,
  locator: Locator,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fn: (resolved: ResolvedLocator) => Promise<T>,
): Promise<T> {
  const resolved = await resolveLocator(cdp, sessionId, locator, timeoutMs, signal);
  try {
    return await fn(resolved);
  } finally {
    await releaseLocator(cdp, sessionId, resolved.objectId);
  }
}
