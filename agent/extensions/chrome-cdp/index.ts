import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { CDP, TargetSessionPool, abortableSleep, connectDiscoveredCdp, raceWithAbort, throwIfAborted } from "./protocol.ts";
import { type Locator, callOnObject, describeLocator, hasLocator, readLocatorMetadata, releaseLocator, resolveLocator, withResolvedLocator } from "./locator.ts";
import { getAxTree } from "./accessibility.ts";
import { DiagnosticsStore, formatDiagnostics, type DiagnosticLevel } from "./diagnostics.ts";
import { clearInspectorState, disposeInspectorSession, inspectLocator } from "./inspector.ts";

const RUNTIME_DIR = resolve(tmpdir(), "pi-chrome-cdp");
mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
const runtimeStat = lstatSync(RUNTIME_DIR);
if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error(`Unsafe Chrome CDP runtime directory: ${RUNTIME_DIR}`);
if (process.platform !== "win32") chmodSync(RUNTIME_DIR, 0o700);

// ── output size guards ──
const MAX_INLINE_BYTES = 2_000;   // max bytes sent to LLM inline; rest goes to files
const FIRST_LOOK_BYTES = 1_200;    // preview bytes embedded in the summary for LLM
const MAX_SNAP_LINES = 80;         // cap AX tree lines
const diagnosticsStore = new DiagnosticsStore();

// ── file-dumping (same pattern as web-smart-fetch) ──

function makeDumpFile(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = label.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 60);
  return resolve(RUNTIME_DIR, `cdp_${ts}_${randomUUID().slice(0, 8)}_${safe}`);
}

function makeFilePrivate(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function dumpToFile(label: string, text: string): string {
  const path = makeDumpFile(label);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  makeFilePrivate(path);
  return path;
}

/** If text is larger than MAX_INLINE_BYTES, dump to a file and return a compact
 *  summary with a first-look preview, metadata, and file path pointing the agent
 *  to use read/grep for full inspection. Otherwise return the text as-is. */
function maybeDump(label: string, text: string, extraMeta?: string): string {
  if (text.length <= MAX_INLINE_BYTES) return text;

  const path = dumpToFile(label, text);
  const preview = text.slice(0, FIRST_LOOK_BYTES);
  const lines = text.split("\n").length;
  const kb = (text.length / 1024).toFixed(1);

  let out = `${preview}\n...\n[Dumped ${kb}KB / ${lines} lines to ${path}`;
  if (extraMeta) out += ` | ${extraMeta}`;
  out += `]\nUse read with offset/limit on this file to inspect specific sections.`;
  return out;
}

function writeTextOutput(outputPath: string, text: string): string {
  const out = resolve(outputPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, { encoding: "utf8", mode: 0o600 });
  makeFilePrivate(out);
  return out;
}

function saveTextResult(outputPath: string, text: string): string {
  const out = writeTextOutput(outputPath, text);
  const preview = text.slice(0, FIRST_LOOK_BYTES);
  const lines = text.split("\n").length;
  const kb = (text.length / 1024).toFixed(1);
  return `${preview}${text.length > FIRST_LOOK_BYTES ? "\n..." : ""}\n[Saved ${kb}KB / ${lines} lines to ${out}]`;
}

function readExpressionFile(expressionPath: string): string {
  const path = resolve(expressionPath);
  if (!existsSync(path)) throw new Error(`expressionPath not found: ${path}`);
  const js = readFileSync(path, "utf8");
  return `${js}\n//# sourceURL=${path.replace(/\\/g, "/")}`;
}

function normalizeTimeout(timeoutMs?: number, fallback = 15000) {
  if (timeoutMs == null) return fallback;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
  return Math.min(Math.max(Math.round(timeoutMs), 100), 10 * 60 * 1000);
}

function evalExpressionFromParams(params: { expression?: string; expressionPath?: string }) {
  if (params.expression && params.expressionPath) throw new Error("Provide either expression or expressionPath, not both");
  return params.expressionPath ? readExpressionFile(params.expressionPath) : (params.expression || "document.title");
}

const ACTIONS = [
  "list", "snap", "html", "inspect", "diagnostics", "eval", "script", "wait", "net",
  "nav", "reload", "open", "download", "raw", "click", "clickxy", "type", "press", "shot", "viewport",
] as const;

const locatorSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector; can be combined with role/name/text filters" })),
  role: Type.Optional(Type.String({ description: "Accessible or implicit role, e.g. button, link, textbox" })),
  name: Type.Optional(Type.String({ description: "Accessible name filter" })),
  text: Type.Optional(Type.String({ description: "Visible text filter" })),
  exact: Type.Optional(Type.Boolean({ description: "Use exact case-insensitive name/text/role matching instead of substring matching" })),
  index: Type.Optional(Type.Number({ description: "Zero-based match index when a locator matches multiple elements" })),
});

const chromeCdpParams = Type.Object({
  action: StringEnum(ACTIONS, { description: "CDP action to perform" }),
  target: Type.Optional(Type.String({ description: "Target tab id prefix from list output, or a distinctive substring of the tab URL/title" })),
  ...locatorSchema.properties,
  locator: Type.Optional(locatorSchema),
  locatorText: Type.Optional(Type.String({ description: "Visible-text locator filter; use this or nested locator.text when action=type because top-level text is the text to insert" })),
  waitFor: Type.Optional(locatorSchema),
  expression: Type.Optional(Type.String({ description: "JavaScript expression for eval/wait" })),
  expressionPath: Type.Optional(Type.String({ description: "Path to a local JavaScript file to evaluate for eval/script" })),
  url: Type.Optional(Type.String({ description: "URL for nav/open/download" })),
  text: Type.Optional(Type.String({ description: "Text to insert for type; for other locator-aware actions, a visible-text locator filter" })),
  clearFirst: Type.Optional(Type.Boolean({ description: "For type, clear the target before inserting text" })),
  key: Type.Optional(Type.String({ description: "Key for press, e.g. Enter, Escape, Tab, ArrowDown, a" })),
  button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Mouse button for click/clickxy" })),
  clickCount: Type.Optional(Type.Number({ description: "Click count, usually 1 or 2" })),
  modifiers: Type.Optional(Type.Array(StringEnum(["Alt", "Control", "Meta", "Shift"] as const), { description: "Keyboard/mouse modifiers" })),
  offsetX: Type.Optional(Type.Number({ description: "Click offset from the matched element's left edge in CSS pixels" })),
  offsetY: Type.Optional(Type.Number({ description: "Click offset from the matched element's top edge in CSS pixels" })),
  x: Type.Optional(Type.Number({ description: "CSS pixel X coordinate for clickxy" })),
  y: Type.Optional(Type.Number({ description: "CSS pixel Y coordinate for clickxy" })),
  outputPath: Type.Optional(Type.String({ description: "Optional output path for shot, html, inspect, diagnostics, eval, net, snap, raw, or download" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds for CDP commands and waits" })),
  waitForSelector: Type.Optional(Type.String({ description: "CSS selector to wait for after open/nav/reload/click/type, or with action=wait" })),
  waitExpression: Type.Optional(Type.String({ description: "JavaScript predicate to wait for after open/nav/reload/click/type, or with action=wait" })),
  settleMs: Type.Optional(Type.Number({ description: "Optional extra delay after an action or successful wait, in milliseconds" })),
  method: Type.Optional(Type.String({ description: "Raw CDP method for action=raw, e.g. DOM.getDocument" })),
  cdpParams: Type.Optional(Type.Any({ description: "Raw CDP params object for action=raw" })),
  useBrowserCookies: Type.Optional(Type.Boolean({ description: "For download, include cookies from the selected browser tab" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional HTTP headers for download" })),
  fullPage: Type.Optional(Type.Boolean({ description: "For shot, capture the full document" })),
  clip: Type.Optional(Type.Object({
    x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number(),
    scale: Type.Optional(Type.Number()),
  }, { description: "For shot, explicit page-coordinate clip in CSS pixels" })),
  imageFormat: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const, { description: "Screenshot image format" })),
  quality: Type.Optional(Type.Number({ description: "JPEG/WebP screenshot quality from 0 to 100" })),
  captureBeyondViewport: Type.Optional(Type.Boolean({ description: "Allow screenshot clips outside the current viewport" })),
  viewport: Type.Optional(Type.Object({
    width: Type.Number(), height: Type.Number(),
    deviceScaleFactor: Type.Optional(Type.Number()),
    mobile: Type.Optional(Type.Boolean()),
    scale: Type.Optional(Type.Number()),
    screenWidth: Type.Optional(Type.Number()),
    screenHeight: Type.Optional(Type.Number()),
  })),
  devicePreset: Type.Optional(StringEnum(["desktop", "laptop", "tablet", "mobile", "iphone-14", "pixel-7"] as const)),
  clearViewport: Type.Optional(Type.Boolean({ description: "For viewport, clear the current device metrics override" })),
  styleProperties: Type.Optional(Type.Array(Type.String(), { description: "Computed CSS properties to include in inspect" })),
  includeAllStyles: Type.Optional(Type.Boolean({ description: "For inspect, include every computed style (usually large)" })),
  includeCssVariables: Type.Optional(Type.Boolean({ description: "For inspect, include relevant computed CSS variables" })),
  includeMatchedRules: Type.Optional(Type.Boolean({ description: "For inspect, include matched CSS rules and source locations" })),
  includeInherited: Type.Optional(Type.Boolean({ description: "For inspect, include inherited matched rules" })),
  includeConsoleLogs: Type.Optional(Type.Boolean({ description: "For diagnostics, include ordinary console log/info entries" })),
  diagnosticsSinceMs: Type.Optional(Type.Number({ description: "For diagnostics, only return entries captured within this many milliseconds" })),
  diagnosticLevels: Type.Optional(Type.Array(StringEnum(["error", "warning", "info", "log"] as const))),
  clearDiagnostics: Type.Optional(Type.Boolean({ description: "Clear matching tab diagnostics after reading" })),
});

type ChromeCdpParams = Locator & {
  action: typeof ACTIONS[number];
  target?: string;
  expression?: string;
  expressionPath?: string;
  url?: string;
  text?: string;
  clearFirst?: boolean;
  locator?: Locator;
  locatorText?: string;
  waitFor?: Locator;
  key?: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  offsetX?: number;
  offsetY?: number;
  x?: number;
  y?: number;
  outputPath?: string;
  timeoutMs?: number;
  waitForSelector?: string;
  waitExpression?: string;
  settleMs?: number;
  method?: string;
  cdpParams?: any;
  useBrowserCookies?: boolean;
  headers?: Record<string, string>;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  imageFormat?: "png" | "jpeg" | "webp";
  quality?: number;
  captureBeyondViewport?: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; scale?: number; screenWidth?: number; screenHeight?: number };
  devicePreset?: "desktop" | "laptop" | "tablet" | "mobile" | "iphone-14" | "pixel-7";
  clearViewport?: boolean;
  styleProperties?: string[];
  includeAllStyles?: boolean;
  includeCssVariables?: boolean;
  includeMatchedRules?: boolean;
  includeInherited?: boolean;
  includeConsoleLogs?: boolean;
  diagnosticsSinceMs?: number;
  diagnosticLevels?: DiagnosticLevel[];
  clearDiagnostics?: boolean;
};

function elementLocator(params: ChromeCdpParams): Locator {
  if (hasLocator(params.locator)) return params.locator!;
  return {
    selector: params.selector,
    role: params.role,
    name: params.name,
    text: params.locatorText ?? (params.action === "type" ? undefined : params.text),
    exact: params.exact,
    index: params.index,
  };
}

const sleep = abortableSleep;

let sharedCdp: CDP | undefined;
let sharedCdpPromise: Promise<CDP> | undefined;
let sharedConnectController: AbortController | undefined;
const sharedConnectWaiters = new Map<Promise<CDP>, number>();
let connectionGeneration = 0;
const sessionPool = new TargetSessionPool();
const navigationTails = new Map<string, Promise<void>>();

function clearCdpRuntimeState(): void {
  sessionPool.clear();
  navigationTails.clear();
  diagnosticsStore.clear();
  clearInspectorState();
}

async function withNavigationLock<T>(sessionId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = navigationTails.get(sessionId) ?? Promise.resolve();
  const run = (async () => {
    await raceWithAbort(previous, signal);
    throwIfAborted(signal);
    return fn();
  })();
  const tail = run.then(() => undefined, () => undefined);
  navigationTails.set(sessionId, tail);
  try {
    return await run;
  } finally {
    if (navigationTails.get(sessionId) === tail) navigationTails.delete(sessionId);
  }
}

function invalidateSharedConnection(closeSocket: boolean): void {
  connectionGeneration++;
  sharedConnectController?.abort();
  sharedConnectController = undefined;
  sharedCdpPromise = undefined;
  const cdp = sharedCdp;
  sharedCdp = undefined;
  clearCdpRuntimeState();
  if (closeSocket) cdp?.close();
}

async function getSharedCdp(signal?: AbortSignal) {
  throwIfAborted(signal);
  if (sharedCdp?.isOpen) return sharedCdp;
  if (sharedCdp && !sharedCdp.isOpen) {
    invalidateSharedConnection(true);
  }
  if (!sharedCdpPromise) {
    const generation = connectionGeneration;
    const controller = new AbortController();
    sharedConnectController = controller;
    const connecting = (async () => {
      const cdp = await connectDiscoveredCdp({ signal: controller.signal });
      if (generation !== connectionGeneration || sharedCdpPromise !== connecting) {
        cdp.close();
        throw new Error("Discarded stale Chrome CDP connection attempt");
      }
      sharedCdp = cdp;
      sharedConnectController = undefined;
      clearCdpRuntimeState();
      cdp.onClose(() => {
        if (sharedCdp === cdp) {
          invalidateSharedConnection(false);
        }
      });
      cdp.onEvent("Target.detachedFromTarget", ({ sessionId }: { sessionId?: string }) => {
        if (!sessionId) return;
        sessionPool.invalidateSession(sessionId);
        diagnosticsStore.disposeSession(sessionId);
        disposeInspectorSession(sessionId);
      });
      cdp.onEvent("Target.targetDestroyed", ({ targetId }: { targetId?: string }) => {
      if (!targetId) return;
      sessionPool.invalidateTarget(targetId);
      diagnosticsStore.disposeTarget(targetId);
    });
      return cdp;
    })();
    sharedCdpPromise = connecting;
    void connecting.catch(() => {
      if (sharedCdpPromise === connecting) {
        sharedCdpPromise = undefined;
        if (sharedConnectController === controller) sharedConnectController = undefined;
      }
    });
  }

  const connecting = sharedCdpPromise;
  sharedConnectWaiters.set(connecting, (sharedConnectWaiters.get(connecting) ?? 0) + 1);
  try {
    return await raceWithAbort(connecting, signal);
  } finally {
    const remaining = Math.max(0, (sharedConnectWaiters.get(connecting) ?? 1) - 1);
    if (remaining === 0) sharedConnectWaiters.delete(connecting);
    else sharedConnectWaiters.set(connecting, remaining);
    if (sharedCdpPromise === connecting && !sharedCdp && remaining === 0 && signal?.aborted) {
      sharedConnectController?.abort();
    }
  }
}

async function getPages(cdp: CDP, signal?: AbortSignal) {
  const { targetInfos } = await cdp.send("Target.getTargets", {}, undefined, 15_000, signal);
  return targetInfos.filter((t: any) => t.type === "page" && !String(t.url || "").startsWith("chrome://"));
}

function formatPages(pages: any[]) {
  return pages
    .map((p) => `${p.targetId.slice(0, 8)}  ${(p.title || "").substring(0, 60)}  ${p.url}`)
    .join("\n");
}

function resolveTarget(pages: any[], query?: string) {
  if (!query) throw new Error("target is required for this action. Run action=list first.");
  const upper = query.toUpperCase();

  const prefixMatches = pages.filter((p) => String(p.targetId).toUpperCase().startsWith(upper));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Ambiguous target prefix: ${query}`);

  const textMatches = pages.filter((p) => `${p.title || ""}\n${p.url || ""}`.toLowerCase().includes(query.toLowerCase()));
  if (textMatches.length === 1) return textMatches[0];
  if (textMatches.length > 1) throw new Error(`Multiple tabs matched '${query}'. Use target id prefix from list.`);

  throw new Error(`No tab matched '${query}'. Run action=list first.`);
}

function formatEvalError(exceptionDetails: any, expression: string): string {
  const exc = exceptionDetails;
  const parts: string[] = [];

  // Build a meaningful error — "Uncaught" alone is useless
  const text = typeof exc.text === "string" ? exc.text.trim() : "";
  const desc = typeof exc.exception?.description === "string" ? exc.exception.description.trim() : "";
  const className = typeof exc.exception?.className === "string" ? exc.exception.className.trim() : "";

  if (className && className !== text) parts.push(className);
  if (text && text !== "Uncaught" && text !== className) parts.push(text);
  if (desc && desc !== text && desc !== className) {
    // Truncate long descriptions but keep the gist
    parts.push(desc.length > 400 ? desc.substring(0, 400) + "…" : desc);
  }

  // Location info
  if (typeof exc.lineNumber === "number") {
    const col = typeof exc.columnNumber === "number" ? `:${exc.columnNumber}` : "";
    parts.push(`line ${exc.lineNumber}${col}`);
  }

  const detail = parts.length > 0 ? parts.join(" — ") : "Evaluation failed";
  const exprSnippet = expression.length > 200 ? expression.substring(0, 200) + "…" : expression;
  return `Eval failed: ${detail}\nExpression: ${exprSnippet}`;
}

async function evalStr(cdp: CDP, sessionId: string, expression: string, timeoutMs?: number, signal?: AbortSignal) {
  const timeout = normalizeTimeout(timeoutMs);
  await cdp.send("Runtime.enable", {}, sessionId, timeout, signal);
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId, timeout, signal);
  if (result.exceptionDetails) {
    throw new Error(formatEvalError(result.exceptionDetails, expression));
  }
  const value = result.result?.value;
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
}

async function snapshotStr(cdp: CDP, sessionId: string, outputPath?: string, timeoutMs?: number, signal?: AbortSignal) {
  const tree = await getAxTree(cdp, sessionId, normalizeTimeout(timeoutMs), signal, true);
  if (outputPath) return saveTextResult(outputPath, tree.text);
  if (tree.lines.length <= MAX_SNAP_LINES) return tree.text;
  const fullPath = dumpToFile("accessibility-tree.txt", tree.text);
  const preview = tree.lines.slice(0, MAX_SNAP_LINES).join("\n");
  return `${tree.shownNodes} accessible nodes (${tree.totalNodes} AX nodes, ${tree.skippedNodes} skipped)\n${preview}\n...\n[Full accessibility tree saved to ${fullPath}]`;
}

async function htmlStr(cdp: CDP, sessionId: string, locator: Locator, outputPath?: string, timeoutMs?: number, signal?: AbortSignal) {
  let raw: string;
  if (hasLocator(locator)) {
    raw = await withResolvedLocator(cdp, sessionId, locator, normalizeTimeout(timeoutMs), signal, (resolved) =>
      callOnObject<string>(cdp, sessionId, resolved.objectId, "function(){ return this.outerHTML || this.textContent || ''; }", { timeoutMs: normalizeTimeout(timeoutMs), signal }),
    );
  } else {
    raw = await evalStr(cdp, sessionId, "document.documentElement.outerHTML", timeoutMs, signal);
  }

  // HTML is always too big — dump to file, return stats + path
  let stats = "";
  try {
    const s = await evalStr(cdp, sessionId,
      `JSON.stringify({bodyChildren: document.body?.children.length??0, totalElements: document.querySelectorAll('*').length, bodyTextChars: (document.body?.textContent||'').length})`,
      timeoutMs,
      signal,
    );
    const parsed = JSON.parse(s);
    stats = `body:${parsed.bodyChildren} kids, ${parsed.totalElements} elements, ${parsed.bodyTextChars} text chars`;
  } catch (error: any) {
    if (error?.name === "AbortError") throw error;
    // Statistics are best-effort.
  }

  if (outputPath) return saveTextResult(outputPath, raw);
  const label = hasLocator(locator) ? `html_element_${describeLocator(locator).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}` : "html_full";
  return maybeDump(label + ".html", raw, stats);
}

async function netStr(cdp: CDP, sessionId: string, outputPath?: string, timeoutMs?: number, signal?: AbortSignal) {
  const raw = await evalStr(cdp, sessionId, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({ name: e.name.substring(0, 200), type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize })))`, timeoutMs, signal);
  const entries: any[] = JSON.parse(raw);
  if (entries.length === 0) return "No resource entries";
  const totalSize = entries.reduce((s: number, e: any) => s + (typeof e.size === "number" ? e.size : 0), 0);
  const totalMs = entries.reduce((s: number, e: any) => s + e.duration, 0);
  const summary = `${entries.length} resources, ${formatBytes(totalSize)}, ${totalMs.toFixed(0)}ms total`;
  const table = entries.map((e: any) =>
    `${String(e.duration).padStart(5)}ms  ${formatBytes(e.size).padStart(8)}  ${String(e.type || "").padEnd(12)}  ${e.name}`
  ).join("\n");
  const full = `${summary}\n${table}`;
  return outputPath ? saveTextResult(outputPath, full) : maybeDump("network.txt", full, `top resources by size/type`);
}

function formatBytes(n: number | undefined | null): string {
  if (n == null || n === 0) return "   0 B";
  if (n < 1024) return `${String(n).padStart(4)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1).padStart(4)}KB`;
  return `${(n / 1048576).toFixed(1).padStart(4)}MB`;
}

function modifierMask(modifiers: ChromeCdpParams["modifiers"]): number {
  let mask = 0;
  for (const modifier of modifiers || []) {
    if (modifier === "Alt") mask |= 1;
    if (modifier === "Control") mask |= 2;
    if (modifier === "Meta") mask |= 4;
    if (modifier === "Shift") mask |= 8;
  }
  return mask;
}

async function clickStr(cdp: CDP, sessionId: string, locator: Locator, options: {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: ChromeCdpParams["modifiers"];
  offsetX?: number;
  offsetY?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const timeout = normalizeTimeout(options.timeoutMs);
  return withResolvedLocator(cdp, sessionId, locator, timeout, options.signal, async (resolved) => {
    const point = await callOnObject<any>(cdp, sessionId, resolved.objectId, `async function(offsetX, offsetY) {
      if (!this.isConnected) return { ok:false, error:'Element is detached' };
      if (this.disabled || this.getAttribute?.('aria-disabled') === 'true') return { ok:false, error:'Element is disabled' };
      this.scrollIntoView({ block:'center', inline:'center', behavior:'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = this.getBoundingClientRect();
      const style = getComputedStyle(this);
      if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) {
        return { ok:false, error:'Element is not visible', rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height} };
      }
      if (style.pointerEvents === 'none') return { ok:false, error:'Element has pointer-events:none' };
      const x = offsetX == null ? rect.left + rect.width / 2 : rect.left + offsetX;
      const y = offsetY == null ? rect.top + rect.height / 2 : rect.top + offsetY;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === this || this.contains(hit))) {
        return { ok:false, error:'Element is covered at the click point', covering:hit ? (hit.tagName + (hit.id ? '#' + hit.id : '')) : null, x, y };
      }
      return { ok:true, x, y, tag:this.tagName, text:(this.innerText || this.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80) };
    }`, {
      arguments: [{ value: options.offsetX ?? null }, { value: options.offsetY ?? null }],
      timeoutMs: timeout,
      signal: options.signal,
    });
    if (!point.ok) throw new Error(`${point.error}${point.covering ? ` (covered by ${point.covering})` : ""}`);
    const button = options.button || "left";
    const clickCount = Math.max(1, Math.min(3, Math.round(options.clickCount ?? 1)));
    const base = { x: point.x, y: point.y, button, clickCount, modifiers: modifierMask(options.modifiers) };
    await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" }, sessionId, timeout, options.signal);
    await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId, timeout, options.signal);
    await sleep(40, options.signal);
    await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId, timeout, options.signal);
    return `Clicked <${point.tag}> ${JSON.stringify(point.text)} at CSS (${Math.round(point.x)}, ${Math.round(point.y)})`;
  });
}

async function clickXyStr(cdp: CDP, sessionId: string, x: number | undefined, y: number | undefined, options: {
  button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: ChromeCdpParams["modifiers"];
  timeoutMs?: number; signal?: AbortSignal;
}) {
  if (typeof x !== "number" || typeof y !== "number") throw new Error("x and y are required for clickxy");
  const timeout = normalizeTimeout(options.timeoutMs);
  const base = {
    x, y, button: options.button || "left",
    clickCount: Math.max(1, Math.min(3, Math.round(options.clickCount ?? 1))),
    modifiers: modifierMask(options.modifiers),
  };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" }, sessionId, timeout, options.signal);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId, timeout, options.signal);
  await sleep(40, options.signal);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId, timeout, options.signal);
  return `Clicked at CSS (${x}, ${y})`;
}

async function acquireInputTarget(cdp: CDP, sessionId: string, locator: Locator, timeout: number, signal?: AbortSignal) {
  if (hasLocator(locator)) return resolveLocator(cdp, sessionId, locator, timeout, signal);
  await cdp.send("Runtime.enable", {}, sessionId, timeout, signal);
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: "document.activeElement",
    returnByValue: false,
    objectGroup: "pi-chrome-cdp-input",
  }, sessionId, timeout, signal);
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("No element is focused; provide selector, role, name, or text");
  const described = await cdp.send("DOM.describeNode", { objectId, depth: 0 }, sessionId, timeout, signal);
  return {
    objectId,
    backendNodeId: described.node?.backendNodeId,
    nodeId: described.node?.nodeId || undefined,
    metadata: await readLocatorMetadata(cdp, sessionId, objectId, timeout, signal),
  };
}

async function typeStr(cdp: CDP, sessionId: string, locator: Locator, options: {
  text?: string; clearFirst?: boolean; timeoutMs?: number; signal?: AbortSignal;
}) {
  if (options.text === undefined) throw new Error("text is required for type");
  const timeout = normalizeTimeout(options.timeoutMs);
  const resolved = await acquireInputTarget(cdp, sessionId, locator, timeout, options.signal);
  try {
    const prepared = await callOnObject<any>(cdp, sessionId, resolved.objectId, `function(clearFirst, locatorSpecified) {
      const tag = String(this.tagName || '').toUpperCase();
      const inputType = tag === 'INPUT' ? String(this.type || 'text').toLowerCase() : '';
      const editableInput = tag === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(inputType);
      const editable = editableInput || tag === 'TEXTAREA' || !!this.isContentEditable;
      const crossOriginFrame = tag === 'IFRAME' || tag === 'FRAME';
      if (tag === 'INPUT' && !editableInput) return { ok:false, error:'Input type ' + inputType + ' does not accept inserted text', tag };
      if (!editable && !crossOriginFrame) return { ok:false, error:'Target is not editable', tag };
      if (crossOriginFrame && locatorSpecified) return { ok:false, error:'A frame locator cannot identify the focused editable element inside the frame; focus it first and call type without a locator', tag };
      if (crossOriginFrame && clearFirst) return { ok:false, error:'clearFirst is unavailable for a focused cross-origin frame', tag };
      if (this.disabled || this.getAttribute?.('aria-disabled') === 'true') return { ok:false, error:'Target is disabled', tag };
      this.scrollIntoView?.({ block:'center', inline:'nearest', behavior:'instant' });
      this.focus?.();
      const focused = document.activeElement === this || this.contains?.(document.activeElement);
      if (!focused && !crossOriginFrame) return { ok:false, error:'Could not focus target', tag };
      const value = editable ? String(this.value ?? this.textContent ?? '') : null;
      if (clearFirst) {
        if (tag === 'INPUT' || tag === 'TEXTAREA') this.select();
        else if (this.isContentEditable) {
          const range = document.createRange(); range.selectNodeContents(this);
          const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        }
      }
      return { ok:true, tag, editable, crossOriginFrame, before:value };
    }`, { arguments: [{ value: !!options.clearFirst }, { value: hasLocator(locator) }], timeoutMs: timeout, signal: options.signal });
    if (!prepared.ok) throw new Error(`${prepared.error}${prepared.tag ? ` (<${prepared.tag}>)` : ""}`);

    if (options.clearFirst) {
      const key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
      await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyDown" }, sessionId, timeout, options.signal);
      await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" }, sessionId, timeout, options.signal);
    }
    if (options.text.length > 0) {
      await cdp.send("Input.insertText", { text: options.text }, sessionId, timeout, options.signal);
    }
    if (prepared.crossOriginFrame) {
      return `Typed ${options.text.length} characters into the focused cross-origin frame (result could not be read back)`;
    }

    const verified = await readLocatorMetadata(cdp, sessionId, resolved.objectId, timeout, options.signal);
    const value = String(verified.value ?? "");
    if (options.text.length > 0 && !options.clearFirst && value === prepared.before) {
      throw new Error(`Typing did not change <${verified.tag}>; the requested text was not inserted`);
    }
    if (options.text.length > 0 && options.clearFirst && value === "") {
      throw new Error(`Typing left <${verified.tag}> empty; the requested text was not inserted`);
    }
    if (options.clearFirst && options.text.length === 0 && value !== "") {
      throw new Error(`Clearing <${verified.tag}> failed; ${value.length} characters remain`);
    }
    const preview = value.slice(0, 120) + (value.length > 120 ? "…" : "");
    return `Typed ${options.text.length} characters into <${verified.tag}>; value is now ${JSON.stringify(preview)}`;
  } finally {
    await releaseLocator(cdp, sessionId, resolved.objectId);
  }
}

function keyDefinition(key: string) {
  const named: Record<string, { key: string; code: string; vk: number; text?: string }> = {
    Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", vk: 27 },
    Tab: { key: "Tab", code: "Tab", vk: 9 },
    Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    Delete: { key: "Delete", code: "Delete", vk: 46 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    Home: { key: "Home", code: "Home", vk: 36 },
    End: { key: "End", code: "End", vk: 35 },
    PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
    PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
    Space: { key: " ", code: "Space", vk: 32, text: " " },
  };
  if (named[key]) return named[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: /[a-z]/i.test(key) ? `Key${upper}` : key, vk: upper.charCodeAt(0), text: key };
  }
  throw new Error(`Unsupported key ${JSON.stringify(key)}; use a printable character or a standard key such as Enter, Escape, Tab, or ArrowDown`);
}

async function pressStr(cdp: CDP, sessionId: string, locator: Locator, options: {
  key?: string; modifiers?: ChromeCdpParams["modifiers"]; timeoutMs?: number; signal?: AbortSignal;
}) {
  if (!options.key) throw new Error("key is required for press");
  const timeout = normalizeTimeout(options.timeoutMs);
  let resolved: Awaited<ReturnType<typeof acquireInputTarget>> | undefined;
  if (hasLocator(locator)) {
    resolved = await acquireInputTarget(cdp, sessionId, locator, timeout, options.signal);
  }
  try {
    if (resolved) {
      const focus = await callOnObject<any>(cdp, sessionId, resolved.objectId, `function(){
        if (!this.isConnected) return {ok:false,error:'Element is detached'};
        if (this.disabled || this.getAttribute?.('aria-disabled') === 'true') return {ok:false,error:'Element is disabled'};
        this.scrollIntoView?.({block:'center',inline:'nearest',behavior:'instant'});
        this.focus?.();
        const focused = document.activeElement === this || !!this.contains?.(document.activeElement);
        return focused ? {ok:true} : {ok:false,error:'Element could not be focused'};
      }`, { timeoutMs: timeout, signal: options.signal });
      if (!focus.ok) throw new Error(`${focus.error}: ${describeLocator(locator)}`);
    }
    const definition = keyDefinition(options.key);
    const emitsText = !!definition.text && !options.modifiers?.some((modifier) => ["Alt", "Control", "Meta"].includes(modifier));
    const params = {
      key: definition.key, code: definition.code,
      windowsVirtualKeyCode: definition.vk, nativeVirtualKeyCode: definition.vk,
      modifiers: modifierMask(options.modifiers),
      ...(emitsText ? { text: definition.text, unmodifiedText: definition.text } : {}),
    };
    await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyDown" }, sessionId, timeout, options.signal);
    await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp", text: undefined, unmodifiedText: undefined }, sessionId, timeout, options.signal);
    return `Pressed ${options.modifiers?.length ? `${options.modifiers.join("+")}+` : ""}${options.key}`;
  } finally {
    if (resolved) await releaseLocator(cdp, sessionId, resolved.objectId);
  }
}

async function waitStr(cdp: CDP, sessionId: string, options: {
  locator?: Locator; expression?: string; timeoutMs?: number; settleMs?: number; signal?: AbortSignal;
}) {
  const timeout = normalizeTimeout(options.timeoutMs, 15000);
  const settleMs = options.settleMs == null ? 0 : Math.max(0, Math.round(options.settleMs));
  const deadline = Date.now() + timeout;
  const locator = options.locator;
  const expression = options.expression;
  if (!hasLocator(locator) && !expression) {
    await waitForReady(cdp, sessionId, timeout, options.signal);
    if (settleMs) await sleep(settleMs, options.signal);
    return `Waited for document.readyState === "complete"${settleMs ? ` and settled ${settleMs}ms` : ""}`;
  }

  let last = "";
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    try {
      if (hasLocator(locator)) {
        const resolved = await resolveLocator(cdp, sessionId, locator!, Math.min(5000, Math.max(100, deadline - Date.now())), options.signal);
        await releaseLocator(cdp, sessionId, resolved.objectId);
        if (settleMs) await sleep(settleMs, options.signal);
        return `Found ${describeLocator(locator!)}${settleMs ? ` and settled ${settleMs}ms` : ""}`;
      }
      if (expression) {
        const ok = await evalStr(cdp, sessionId, `(async () => Boolean(await (${expression})))()`, Math.min(5000, Math.max(100, deadline - Date.now())), options.signal);
        last = ok;
        if (ok === "true") {
          if (settleMs) await sleep(settleMs, options.signal);
          return `Wait expression became truthy${settleMs ? ` and settled ${settleMs}ms` : ""}`;
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      last = e?.message || String(e);
    }
    await sleep(200, options.signal);
  }
  const target = hasLocator(locator) ? describeLocator(locator!) : "expression";
  throw new Error(`Timed out waiting for ${target}${last ? ` (last: ${last})` : ""}`);
}

type PostActionOptions = { waitFor?: Locator; waitForSelector?: string; waitExpression?: string; timeoutMs?: number; settleMs?: number; signal?: AbortSignal };

async function postActionWait(cdp: CDP, sessionId: string, options: PostActionOptions) {
  const locator = hasLocator(options.waitFor) ? options.waitFor : options.waitForSelector ? { selector: options.waitForSelector } : undefined;
  if (!hasLocator(locator) && !options.waitExpression && !options.settleMs) return "";
  return waitStr(cdp, sessionId, {
    locator,
    expression: options.waitExpression,
    timeoutMs: options.timeoutMs,
    settleMs: options.settleMs,
    signal: options.signal,
  });
}

function withWaitSuffix(text: string, waited: string) {
  return waited ? `${text}; ${waited}` : text;
}

async function waitForReady(cdp: CDP, sessionId: string, timeoutMs = 30000, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const state = await evalStr(cdp, sessionId, "document.readyState", Math.min(5000, Math.max(100, deadline - Date.now())), signal).catch((error) => {
      if (error?.name === "AbortError") throw error;
      return "";
    });
    if (state === "complete") return;
    await sleep(200, signal);
  }
  throw new Error("Timed out waiting for page to finish loading");
}

async function navStr(cdp: CDP, sessionId: string, options: PostActionOptions & { url?: string }) {
  return withNavigationLock(sessionId, options.signal, async () => {
    const { url } = options;
    if (!url) throw new Error("url is required for nav");
    const timeout = normalizeTimeout(options.timeoutMs, 30000);
    await cdp.send("Page.enable", {}, sessionId, timeout, options.signal);
    const loadEvent = cdp.waitForEvent("Page.loadEventFired", timeout, sessionId, options.signal);
    try {
      const result = await cdp.send("Page.navigate", { url }, sessionId, timeout, options.signal);
      if (result.errorText) throw new Error(result.errorText);
      if (result.loaderId) await loadEvent.promise;
      await waitForReady(cdp, sessionId, Math.min(5000, timeout), options.signal);
      const waited = await postActionWait(cdp, sessionId, {
        waitFor: options.waitFor,
        waitForSelector: options.waitForSelector,
        waitExpression: options.waitExpression,
        timeoutMs: Math.max(100, timeout - 1000),
        settleMs: options.settleMs,
        signal: options.signal,
      });
      return withWaitSuffix(`Navigated to ${url}`, waited);
    } finally {
      // If Page.navigate times out or fails before we await loadEvent.promise,
      // cancel the pending timer/listener to avoid an unhandled rejection.
      loadEvent.cancel();
    }
  });
}

async function reloadStr(cdp: CDP, sessionId: string, options: PostActionOptions) {
  return withNavigationLock(sessionId, options.signal, async () => {
    const timeout = normalizeTimeout(options.timeoutMs, 30000);
    await cdp.send("Page.enable", {}, sessionId, timeout, options.signal);
    const loadEvent = cdp.waitForEvent("Page.loadEventFired", timeout, sessionId, options.signal);
    try {
      await cdp.send("Page.reload", {}, sessionId, timeout, options.signal);
      await loadEvent.promise;
      await waitForReady(cdp, sessionId, Math.min(5000, timeout), options.signal);
      const waited = await postActionWait(cdp, sessionId, {
        ...options,
        timeoutMs: Math.max(100, timeout - 1000),
      });
      return withWaitSuffix("Reloaded page", waited);
    } finally {
      loadEvent.cancel();
    }
  });
}

async function shotStr(cdp: CDP, sessionId: string, targetId: string, locator: Locator, options: {
  outputPath?: string; timeoutMs?: number; fullPage?: boolean;
  clip?: ChromeCdpParams["clip"]; imageFormat?: ChromeCdpParams["imageFormat"];
  quality?: number; captureBeyondViewport?: boolean; signal?: AbortSignal;
}) {
  const timeout = normalizeTimeout(options.timeoutMs, 30_000);
  const locatorRequested = hasLocator(locator);
  const modes = Number(locatorRequested) + Number(!!options.fullPage) + Number(!!options.clip);
  if (modes > 1) throw new Error("For shot, choose only one of an element locator, fullPage, or clip");
  const format = options.imageFormat || "png";
  const quality = options.quality == null ? undefined : Math.max(0, Math.min(100, Math.round(options.quality)));
  let clip: any = options.clip ? {
    x: options.clip.x, y: options.clip.y, width: options.clip.width, height: options.clip.height,
    scale: options.clip.scale ?? 1,
  } : undefined;

  if (locatorRequested) {
    clip = await withResolvedLocator(cdp, sessionId, locator, timeout, options.signal, async (resolved) => {
      await callOnObject(cdp, sessionId, resolved.objectId, "async function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); await new Promise(r=>requestAnimationFrame(r)); return true; }", { timeoutMs: timeout, signal: options.signal });
      const metadata = await readLocatorMetadata(cdp, sessionId, resolved.objectId, timeout, options.signal);
      if (!metadata.visible) throw new Error(`Cannot screenshot hidden element ${describeLocator(locator)}`);
      return { ...metadata.pageRect, scale: 1 };
    });
  } else if (options.fullPage) {
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId, timeout, options.signal);
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size?.width || !size?.height) throw new Error("Chrome did not return full-page layout dimensions");
    clip = { x: size.x || 0, y: size.y || 0, width: size.width, height: size.height, scale: 1 };
  }

  if (clip && (!(clip.width > 0) || !(clip.height > 0))) throw new Error("Screenshot clip width and height must be positive");
  const captureParams: any = {
    format,
    fromSurface: true,
    captureBeyondViewport: options.captureBeyondViewport ?? !!clip,
  };
  if (clip) captureParams.clip = clip;
  if (format !== "png" && quality != null) captureParams.quality = quality;
  const { data } = await cdp.send("Page.captureScreenshot", captureParams, sessionId, timeout, options.signal);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = options.outputPath ? resolve(options.outputPath) : resolve(RUNTIME_DIR, `screenshot-${targetId.slice(0, 8)}-${stamp}.${format === "jpeg" ? "jpg" : format}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(data, "base64"), { mode: 0o600 });
  makeFilePrivate(out);
  const dpr = parseFloat(await evalStr(cdp, sessionId, "window.devicePixelRatio", timeout, options.signal).catch((error) => {
    if (error?.name === "AbortError") throw error;
    return "1";
  })) || 1;
  const mode = locatorRequested ? `element ${describeLocator(locator)}` : options.fullPage ? "full page" : clip ? "clip" : "viewport";
  return `${out}\nScreenshot saved (${mode}, ${format}). DPR: ${dpr}${clip ? `; CSS clip ${Math.round(clip.width)}×${Math.round(clip.height)}` : ""}`;
}

async function rawStr(cdp: CDP, sessionId: string, method?: string, cdpParams?: any, outputPath?: string, timeoutMs?: number, signal?: AbortSignal) {
  if (!method) throw new Error("method is required for raw");
  const rootScoped = /^(?:Browser|Target|SystemInfo|Memory)\./.test(method);
  const result = await cdp.send(method, cdpParams || {}, rootScoped ? undefined : sessionId, normalizeTimeout(timeoutMs), signal);
  const text = JSON.stringify(result, null, 2);
  return outputPath ? saveTextResult(outputPath, text) : text;
}

async function openStr(url: string | undefined, options: PostActionOptions) {
  throwIfAborted(options.signal);
  const cdp = await getSharedCdp(options.signal);
  const openUrl = url || "about:blank";
  const timeout = normalizeTimeout(options.timeoutMs);
  const { targetId } = await cdp.send("Target.createTarget", { url: openUrl }, undefined, timeout, options.signal);
  let waited = "";
  if (hasLocator(options.waitFor) || options.waitForSelector || options.waitExpression || options.settleMs) {
    const sessionId = await getOrAttachSession(cdp, targetId, timeout, options.signal);
    waited = await postActionWait(cdp, sessionId, options);
  }
  return {
    targetId,
    text: withWaitSuffix(`Opened new tab: ${String(targetId).slice(0, 8)}  ${openUrl}`, waited),
  };
}

function inferDownloadPath(url: string) {
  let name = "download.bin";
  try {
    const parsed = new URL(url);
    const base = basename(parsed.pathname);
    if (base) name = decodeURIComponent(base).replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
  } catch { /* validated by fetch */ }
  return resolve(RUNTIME_DIR, name);
}

async function downloadStr(options: { url?: string; outputPath?: string; headers?: Record<string, string>; cookies?: string; timeoutMs?: number; signal?: AbortSignal }) {
  if (!options.url) throw new Error("url is required for download");
  throwIfAborted(options.signal);
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.cookies && !headers.cookie && !headers.Cookie) headers.cookie = options.cookies;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeTimeout(options.timeoutMs, 30000));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(options.url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    const out = options.outputPath ? resolve(options.outputPath) : inferDownloadPath(options.url);
    mkdirSync(dirname(out), { recursive: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(out, bytes, { mode: 0o600 });
    makeFilePrivate(out);
    const type = response.headers.get("content-type") || "unknown type";
    return `${out}\nDownloaded ${formatBytes(bytes.length)} (${type}) from ${options.url}`;
  } catch (e: any) {
    throwIfAborted(options.signal);
    if (e?.name === "AbortError") throw new Error(`Download timed out after ${normalizeTimeout(options.timeoutMs, 30000)}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

const DEVICE_PRESETS: Record<NonNullable<ChromeCdpParams["devicePreset"]>, NonNullable<ChromeCdpParams["viewport"]>> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
  "iphone-14": { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  "pixel-7": { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
};

async function viewportStr(cdp: CDP, sessionId: string, options: {
  viewport?: ChromeCdpParams["viewport"]; devicePreset?: ChromeCdpParams["devicePreset"];
  clearViewport?: boolean; timeoutMs?: number; signal?: AbortSignal;
}) {
  const timeout = normalizeTimeout(options.timeoutMs);
  if (options.clearViewport) {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId, timeout, options.signal);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId, timeout, options.signal).catch(() => {});
    const actual = await evalStr(cdp, sessionId, "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,mobile:navigator.userAgentData?.mobile??null})", timeout, options.signal);
    return `Cleared viewport override\n${actual}`;
  }
  if (options.viewport && options.devicePreset) throw new Error("Provide viewport or devicePreset, not both");
  const viewport = options.viewport || (options.devicePreset ? DEVICE_PRESETS[options.devicePreset] : undefined);
  if (!viewport) throw new Error("viewport action requires viewport, devicePreset, or clearViewport=true");
  if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error("Viewport width and height must be positive");
  const params = {
    width: Math.round(viewport.width), height: Math.round(viewport.height),
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    mobile: viewport.mobile ?? false,
    scale: viewport.scale ?? 1,
    screenWidth: Math.round(viewport.screenWidth ?? viewport.width),
    screenHeight: Math.round(viewport.screenHeight ?? viewport.height),
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", params, sessionId, timeout, options.signal);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: params.mobile,
    maxTouchPoints: params.mobile ? 5 : 1,
  }, sessionId, timeout, options.signal).catch((error) => {
    if (error?.name === "AbortError") throw error;
  });
  const actual = await evalStr(cdp, sessionId, "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,mobile:navigator.userAgentData?.mobile??null})", timeout, options.signal);
  return `Applied ${options.devicePreset ? `${options.devicePreset} preset` : "viewport override"}\n${actual}`;
}

async function getOrAttachSession(cdp: CDP, targetId: string, timeoutMs = 15_000, signal?: AbortSignal) {
  const sessionId = await sessionPool.get(cdp, targetId, signal);
  await diagnosticsStore.ensure(cdp, sessionId, targetId, timeoutMs, signal);
  return sessionId;
}

async function withTarget<T>(targetQuery: string | undefined, signal: AbortSignal | undefined, fn: (cdp: CDP, sessionId: string, page: any) => Promise<T>) {
  throwIfAborted(signal);
  const cdp = await getSharedCdp(signal);
  const pages = await getPages(cdp, signal);
  const page = resolveTarget(pages, targetQuery);
  const sessionId = await getOrAttachSession(cdp, page.targetId, 15_000, signal);

  try {
    return await fn(cdp, sessionId, page);
  } catch (e: any) {
    // If Chrome invalidated a cached session, forget it so the next call re-attaches.
    if (String(e?.message || "").toLowerCase().includes("session")) {
      sessionPool.invalidateTarget(page.targetId);
      diagnosticsStore.disposeSession(sessionId);
    }
    throw e;
  }
}

// Named only for deterministic mock-CDP tests. The Pi extension surface remains
// the default export below.
export const __testing = {
  clickStr, typeStr, pressStr, waitStr, navStr, reloadStr, rawStr,
};

export default function chromeCdpExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    invalidateSharedConnection(true);
  });

  pi.registerTool({
    name: "chrome_cdp",
    label: "Chrome CDP",
    description: "Inspect and control tabs in already-open local Chrome via Chrome DevTools Protocol. Supports accessible locators, trusted clicks and keyboard input, compact style inspection, diagnostics, screenshots, viewport emulation, arbitrary JavaScript, and raw CDP commands.",
    promptSnippet: "Inspect and control the user's live Chrome tabs via Chrome DevTools Protocol (CDP)",
    promptGuidelines: [
      "Use chrome_cdp when the user wants to inspect or control their already-open Chrome instance.",
      "Use chrome_cdp action=list before other chrome_cdp actions when you need a tab id.",
      "Use chrome_cdp action=net to inspect resource URLs loaded by the current page.",
      "Prefer chrome_cdp role/name/text/CSS locators over custom eval scripts for click, type, press, wait, html, inspect, and element screenshots.",
      "Use chrome_cdp action=inspect for compact bounds, computed styles, matched CSS rules, fonts, variables, and pseudo-elements before writing bespoke style-extraction scripts.",
      "Use chrome_cdp action=diagnostics after exercising a page to check captured exceptions, console errors, browser logs, and failed requests.",
      "Use outputPath for large html/eval/net/snap/raw results when you want a stable file path instead of a temp dump.",
      "Use expressionPath for reusable JavaScript files and waitForSelector/settleMs after actions when pages update asynchronously.",
      "chrome_cdp dumps large outputs (>2KB) to temp files to protect context. When you see [Dumped … to C:\\...], use read with offset/limit to inspect the file instead of re-running chrome_cdp.",
    ],
    parameters: chromeCdpParams,
    async execute(_toolCallId, params: ChromeCdpParams, signal, _onUpdate, _ctx) {
      throwIfAborted(signal);
      if (params.action === "list") {
        const started = Date.now();
        const cdp = await getSharedCdp(signal);
        const pages = await getPages(cdp, signal);
        return {
          content: [{ type: "text", text: formatPages(pages) || "No pages found." }],
          details: { action: "list", count: pages.length, elapsedMs: Date.now() - started },
        };
      }

      const started = Date.now();

      if (params.action === "open") {
        const opened = await openStr(params.url, {
          waitFor: params.waitFor,
          waitForSelector: params.waitForSelector,
          waitExpression: params.waitExpression,
          timeoutMs: params.timeoutMs,
          settleMs: params.settleMs,
          signal,
        });
        return {
          content: [{ type: "text", text: opened.text }],
          details: { action: "open", target: String(opened.targetId).slice(0, 8), elapsedMs: Date.now() - started, url: params.url || "about:blank" },
        };
      }

      if (params.action === "download" && !params.useBrowserCookies) {
        const text = await downloadStr({ url: params.url, outputPath: params.outputPath, headers: params.headers, timeoutMs: params.timeoutMs, signal });
        return {
          content: [{ type: "text", text }],
          details: { action: "download", elapsedMs: Date.now() - started, url: params.url, outputPath: params.outputPath },
        };
      }

      let pageMeta: { url: string; title: string } = { url: "", title: "" };

      const text = await withTarget(params.target, signal, async (cdp, sessionId, page) => {
        pageMeta = { url: (page as any).url as string ?? "", title: (page as any).title as string ?? "" };
        const locator = elementLocator(params);
        const postOptions: PostActionOptions = {
          waitFor: params.waitFor,
          waitForSelector: params.waitForSelector,
          waitExpression: params.waitExpression,
          timeoutMs: params.timeoutMs,
          settleMs: params.settleMs,
          signal,
        };
        switch (params.action) {
          case "snap": return snapshotStr(cdp, sessionId, params.outputPath, params.timeoutMs, signal);
          case "html": return htmlStr(cdp, sessionId, locator, params.outputPath, params.timeoutMs, signal);
          case "inspect": {
            if (!hasLocator(locator)) throw new Error("inspect requires selector, role, name, or text");
            const inspected = await inspectLocator(cdp, sessionId, locator, {
              styleProperties: params.styleProperties,
              includeAllStyles: params.includeAllStyles,
              includeCssVariables: params.includeCssVariables,
              includeMatchedRules: params.includeMatchedRules,
              includeInherited: params.includeInherited,
            }, normalizeTimeout(params.timeoutMs), signal);
            const result = JSON.stringify(inspected, null, 2);
            return params.outputPath ? saveTextResult(params.outputPath, result) : result;
          }
          case "diagnostics": {
            const result = formatDiagnostics(diagnosticsStore.read(page.targetId, {
              includeConsoleLogs: params.includeConsoleLogs,
              sinceMs: params.diagnosticsSinceMs,
              levels: params.diagnosticLevels,
              clear: params.clearDiagnostics,
            }));
            return params.outputPath ? saveTextResult(params.outputPath, result) : result;
          }
          case "eval": {
            const result = await evalStr(cdp, sessionId, evalExpressionFromParams(params), params.timeoutMs, signal);
            await postActionWait(cdp, sessionId, postOptions);
            return params.outputPath ? saveTextResult(params.outputPath, result) : result;
          }
          case "script": {
            if (!params.expressionPath) throw new Error("expressionPath is required for script");
            const result = await evalStr(cdp, sessionId, readExpressionFile(params.expressionPath), params.timeoutMs, signal);
            await postActionWait(cdp, sessionId, postOptions);
            return params.outputPath ? saveTextResult(params.outputPath, result) : result;
          }
          case "wait": return waitStr(cdp, sessionId, {
            locator: hasLocator(locator) ? locator : hasLocator(params.waitFor) ? params.waitFor : params.waitForSelector ? { selector: params.waitForSelector } : undefined,
            expression: params.waitExpression || params.expression,
            timeoutMs: params.timeoutMs,
            settleMs: params.settleMs,
            signal,
          });
          case "net": return netStr(cdp, sessionId, params.outputPath, params.timeoutMs, signal);
          case "nav": {
            if (!params.url) throw new Error("url is required for nav");
            return navStr(cdp, sessionId, { ...postOptions, url: params.url });
          }
          case "reload": return reloadStr(cdp, sessionId, postOptions);
          case "download": {
            if (!params.url) throw new Error("url is required for download");
            const { cookies } = await cdp.send("Network.getCookies", { urls: params.url ? [params.url] : [] }, sessionId, normalizeTimeout(params.timeoutMs), signal);
            const cookieHeader = Array.isArray(cookies) ? cookies.map((c: any) => `${c.name}=${c.value}`).join("; ") : undefined;
            return downloadStr({ url: params.url, outputPath: params.outputPath, headers: params.headers, cookies: cookieHeader, timeoutMs: params.timeoutMs, signal });
          }
          case "raw": return rawStr(cdp, sessionId, params.method, params.cdpParams, params.outputPath, params.timeoutMs, signal);
          case "click": {
            const clicked = await clickStr(cdp, sessionId, locator, {
              button: params.button, clickCount: params.clickCount, modifiers: params.modifiers,
              offsetX: params.offsetX, offsetY: params.offsetY, timeoutMs: params.timeoutMs, signal,
            });
            const waited = await postActionWait(cdp, sessionId, postOptions);
            return withWaitSuffix(clicked, waited);
          }
          case "clickxy": {
            const clicked = await clickXyStr(cdp, sessionId, params.x, params.y, {
              button: params.button, clickCount: params.clickCount, modifiers: params.modifiers,
              timeoutMs: params.timeoutMs, signal,
            });
            const waited = await postActionWait(cdp, sessionId, postOptions);
            return withWaitSuffix(clicked, waited);
          }
          case "type": {
            const typed = await typeStr(cdp, sessionId, locator, { text: params.text, clearFirst: params.clearFirst, timeoutMs: params.timeoutMs, signal });
            const waited = await postActionWait(cdp, sessionId, postOptions);
            return withWaitSuffix(typed, waited);
          }
          case "press": {
            const pressed = await pressStr(cdp, sessionId, locator, { key: params.key, modifiers: params.modifiers, timeoutMs: params.timeoutMs, signal });
            const waited = await postActionWait(cdp, sessionId, postOptions);
            return withWaitSuffix(pressed, waited);
          }
          case "shot": return shotStr(cdp, sessionId, page.targetId, locator, {
            outputPath: params.outputPath, timeoutMs: params.timeoutMs, fullPage: params.fullPage,
            clip: params.clip, imageFormat: params.imageFormat, quality: params.quality,
            captureBeyondViewport: params.captureBeyondViewport, signal,
          });
          case "viewport": return viewportStr(cdp, sessionId, {
            viewport: params.viewport, devicePreset: params.devicePreset, clearViewport: params.clearViewport,
            timeoutMs: params.timeoutMs, signal,
          });
          default: throw new Error(`Unsupported action: ${params.action}`);
        }
      });

      const elapsedMs = Date.now() - started;
      const rawText = text || "(no output)";

      // Catch-all: if any action produced large output that wasn't already dumped,
      // dump it now to protect the context window.
      const capped = rawText.length > MAX_INLINE_BYTES
        ? maybeDump(`${params.action}.txt`, rawText, `action=${params.action}`)
        : rawText;

      return {
        content: [{ type: "text", text: capped }],
        details: {
          action: params.action,
          target: params.target,
          elapsedMs,
          pageUrl: pageMeta.url,
          pageTitle: pageMeta.title,
          outputBytes: rawText.length,
          outputPath: params.outputPath,
          selector: params.selector,
          locator: hasLocator(elementLocator(params)) ? describeLocator(elementLocator(params)) : undefined,
          dumped: rawText.length > MAX_INLINE_BYTES || rawText.includes("[Dumped ") || rawText.includes("[Saved "),
        },
      };
    },

    // ── custom TUI rendering ──

    renderCall(args: ChromeCdpParams, theme: any) {
      const parts: string[] = [theme.bold("chrome_cdp")];
      parts.push(theme.fg("muted", args.action));

      if (args.target) {
        parts.push(theme.fg("dim", args.target.length > 20 ? args.target.slice(0, 20) + "…" : args.target));
      }
      if (args.expression) {
        const short = args.expression.length > 60 ? args.expression.slice(0, 60) + "…" : args.expression;
        parts.push(theme.fg("dim", short));
      }
      if (args.expressionPath) {
        const short = args.expressionPath.length > 50 ? args.expressionPath.slice(0, 50) + "…" : args.expressionPath;
        parts.push(theme.fg("dim", short));
      }
      if (args.method) {
        parts.push(theme.fg("dim", args.method));
      }
      if (args.url) {
        const short = args.url.length > 40 ? args.url.slice(0, 40) + "…" : args.url;
        parts.push(theme.fg("dim", short));
      }
      if (args.selector) {
        parts.push(theme.fg("dim", args.selector.length > 30 ? args.selector.slice(0, 30) + "…" : args.selector));
      }
      if (!args.selector && (args.locator || args.role || args.name || args.locatorText || (args.action !== "type" && args.text))) {
        const locator = describeLocator(elementLocator(args));
        parts.push(theme.fg("dim", locator.length > 50 ? locator.slice(0, 50) + "…" : locator));
      }
      if (args.waitForSelector) {
        parts.push(theme.fg("dim", args.waitForSelector.length > 30 ? args.waitForSelector.slice(0, 30) + "…" : args.waitForSelector));
      }
      if (args.outputPath) {
        parts.push(theme.fg("dim", `→ ${args.outputPath.length > 34 ? args.outputPath.slice(0, 34) + "…" : args.outputPath}`));
      }

      return new Text(parts.join(" "), 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details || {};
      const action = details.action || "?";

      switch (action) {
        case "list": {
          const n = details.count ?? 0;
          return new Text(theme.fg("success", `\u2713 ${n} tab${n === 1 ? "" : "s"}${details.elapsedMs != null ? ` \u00b7 ${(details.elapsedMs / 1000).toFixed(1)}s` : ""}`), 0, 0);
        }
        case "eval":
        case "script": {
          const raw = String(result.content?.[0]?.text ?? "");
          if (raw.startsWith("Eval failed:")) {
            const firstLine = raw.split("\n")[0].replace("Eval failed: ", "");
            return new Text(theme.fg("error", `\u2717 ${firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine}`), 0, 0);
          }
          const dumped = (details.dumped ?? false) || raw.includes("[Dumped ") || raw.includes("[Saved ");
          if (dumped) {
            return new Text(theme.fg("info", `\u2713 ${action} \u2192 file (${formatBytes(details.outputBytes)})`), 0, 0);
          }
          const short = raw.length > 120 ? raw.slice(0, 120).replace(/\n/g, " \u00b7 ") + "…" : raw.replace(/\n/g, " \u00b7 ");
          return new Text(theme.fg("success", `\u2713 ${short}`), 0, 0);
        }
        case "snap": {
          const raw = String(result.content?.[0]?.text ?? "");
          const firstLine = raw.split("\n")[0] || "";
          const dumped = (details.dumped ?? false) || raw.includes("[Saved ") || raw.includes("[Dumped ");
          return new Text(theme.fg(dumped ? "info" : "success", `\u2713 ${firstLine}${dumped ? " \u2192 file" : ""}`), 0, 0);
        }
        case "html": {
          const bytes = details.outputBytes ?? 0;
          const selector = details.selector;
          const raw = String(result.content?.[0]?.text ?? "");
          const dumped = (details.dumped ?? false) || raw.includes("[Saved ") || raw.includes("[Dumped ");
          return new Text(
            theme.fg(dumped ? "info" : "success", `\u2713 HTML ${formatBytes(bytes)}${selector ? ` (${selector})` : ""}${dumped ? " \u2192 file" : ""}`),
            0, 0
          );
        }
        case "net":
        case "inspect":
        case "diagnostics": {
          const raw = String(result.content?.[0]?.text ?? "");
          const firstLine = raw.split("\n")[0] || "";
          const dumped = (details.dumped ?? false) || raw.includes("[Saved ") || raw.includes("[Dumped ");
          return new Text(theme.fg(dumped ? "info" : "success", `\u2713 ${firstLine}${dumped ? " \u2192 file" : ""}`), 0, 0);
        }
        case "nav":
        case "wait":
        case "open":
        case "download":
        case "raw": {
          const raw = String(result.content?.[0]?.text ?? "");
          const firstLine = raw.split("\n")[0] || action;
          const dumped = (details.dumped ?? false) || raw.includes("[Saved ") || raw.includes("[Dumped ");
          return new Text(theme.fg(dumped ? "info" : "success", `\u2713 ${firstLine}${dumped ? " \u2192 file" : ""}`), 0, 0);
        }
        case "reload": {
          return new Text(theme.fg("success", `\u2713 ${String(result.content?.[0]?.text ?? "")}`), 0, 0);
        }
        case "click":
        case "clickxy":
        case "press":
        case "viewport": {
          return new Text(theme.fg("success", `\u2713 ${String(result.content?.[0]?.text ?? "")}`), 0, 0);
        }
        case "type": {
          return new Text(theme.fg("success", `\u2713 ${String(result.content?.[0]?.text ?? "")}`), 0, 0);
        }
        case "shot": {
          const text = String(result.content?.[0]?.text ?? "");
          const firstLine = text.split("\n")[0] || "";
          return new Text(theme.fg("success", `\u2713 ${firstLine}`), 0, 0);
        }
        default: {
          if (result.isError) {
            return new Text(theme.fg("error", `\u2717 ${String(result.content?.[0]?.text ?? "").split("\n")[0]}`), 0, 0);
          }
          return new Text(theme.fg("success", `\u2713 ${action}`), 0, 0);
        }
      }
    },
  });
}
