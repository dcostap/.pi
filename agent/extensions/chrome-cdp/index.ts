import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
const RUNTIME_DIR = resolve(tmpdir(), "pi-chrome-cdp");
mkdirSync(RUNTIME_DIR, { recursive: true });

const chromeCdpParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("snap"),
    Type.Literal("html"),
    Type.Literal("eval"),
    Type.Literal("net"),
    Type.Literal("nav"),
    Type.Literal("reload"),
    Type.Literal("click"),
    Type.Literal("clickxy"),
    Type.Literal("type"),
    Type.Literal("shot"),
  ], { description: "CDP action to perform" }),
  target: Type.Optional(Type.String({ description: "Target tab id prefix from list output, or a distinctive substring of the tab URL/title" })),
  selector: Type.Optional(Type.String({ description: "CSS selector for html or click actions" })),
  expression: Type.Optional(Type.String({ description: "JavaScript expression for eval" })),
  url: Type.Optional(Type.String({ description: "URL for nav" })),
  text: Type.Optional(Type.String({ description: "Text for type" })),
  x: Type.Optional(Type.Number({ description: "CSS pixel X coordinate for clickxy" })),
  y: Type.Optional(Type.Number({ description: "CSS pixel Y coordinate for clickxy" })),
  outputPath: Type.Optional(Type.String({ description: "Optional screenshot output path for shot" })),
});

type ChromeCdpParams = {
  action: "list" | "snap" | "html" | "eval" | "net" | "nav" | "reload" | "click" | "clickxy" | "type" | "shot";
  target?: string;
  selector?: string;
  expression?: string;
  url?: string;
  text?: string;
  x?: number;
  y?: number;
  outputPath?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CDP {
  #ws?: WebSocket;
  #id = 0;
  #closed = true;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #handlers = new Map<string, Set<(params: any) => void>>();
  #closeHandlers = new Set<() => void>();

  get isOpen() {
    return !!this.#ws && !this.#closed;
  }

  async connect(wsUrl: string) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      this.#ws = ws;
      this.#closed = false;
      ws.onopen = () => resolvePromise();
      ws.onerror = (e: any) => rejectPromise(new Error(`WebSocket error: ${e?.message || e?.type || "unknown"}`));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && this.#pending.has(msg.id)) {
          const pending = this.#pending.get(msg.id)!;
          this.#pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
          else pending.resolve(msg.result);
          return;
        }
        if (msg.method && this.#handlers.has(msg.method)) {
          for (const handler of this.#handlers.get(msg.method)!) handler(msg.params || {});
        }
      };
      ws.onclose = () => {
        this.#closed = true;
        for (const [id, pending] of this.#pending) {
          pending.reject(new Error(`WebSocket closed while waiting for response ${id}`));
        }
        this.#pending.clear();
        for (const handler of this.#closeHandlers) handler();
      };
    });
  }

  send(method: string, params: any = {}, sessionId?: string) {
    const id = ++this.#id;
    return new Promise<any>((resolvePromise, rejectPromise) => {
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      const msg: any = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws!.send(JSON.stringify(msg));
      setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        rejectPromise(new Error(`Timeout: ${method}`));
      }, 15000);
    });
  }

  onEvent(method: string, handler: (params: any) => void) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method)!.add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  waitForEvent(method: string, timeoutMs = 15000) {
    let off: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<any>((resolvePromise, rejectPromise) => {
      off = this.onEvent(method, (params) => {
        clearTimeout(timer);
        off?.();
        resolvePromise(params);
      });
      timer = setTimeout(() => {
        off?.();
        rejectPromise(new Error(`Timeout waiting for event: ${method}`));
      }, timeoutMs);
    });
    return {
      promise,
      cancel() {
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler: () => void) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  close() {
    this.#ws?.close();
  }
}

let sharedCdp: CDP | undefined;
let sharedCdpPromise: Promise<CDP> | undefined;
const sessionCache = new Map<string, string>();

async function getSharedCdp() {
  if (sharedCdp?.isOpen) return sharedCdp;
  if (sharedCdpPromise) return sharedCdpPromise;

  sharedCdpPromise = (async () => {
    const cdp = new CDP();
    await cdp.connect(getWsUrl());
    sharedCdp = cdp;
    sessionCache.clear();
    cdp.onClose(() => {
      if (sharedCdp === cdp) sharedCdp = undefined;
      sharedCdpPromise = undefined;
      sessionCache.clear();
    });
    return cdp;
  })();

  try {
    return await sharedCdpPromise;
  } catch (e) {
    sharedCdpPromise = undefined;
    throw e;
  }
}

function getWsUrl() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || resolve(home, "AppData", "Local");
  const candidates = [
    process.env.CDP_PORT_FILE,
    resolve(local, "Google", "Chrome", "User Data", "DevToolsActivePort"),
    resolve(local, "Google", "Chrome", "User Data", "Default", "DevToolsActivePort"),
    resolve(local, "Chromium", "User Data", "DevToolsActivePort"),
    resolve(local, "BraveSoftware", "Brave-Browser", "User Data", "DevToolsActivePort"),
    resolve(local, "Microsoft", "Edge", "User Data", "DevToolsActivePort"),
    resolve(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort"),
  ].filter(Boolean) as string[];

  const portFile = candidates.find((p) => existsSync(p));
  if (!portFile) throw new Error(`DevToolsActivePort not found. Tried: ${candidates.join(", ")}`);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  return `ws://127.0.0.1:${port}${path}`;
}

async function getPages(cdp: CDP) {
  const { targetInfos } = await cdp.send("Target.getTargets");
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

async function evalStr(cdp: CDP, sessionId: string, expression: string) {
  await cdp.send("Runtime.enable", {}, sessionId);
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Evaluation failed");
  const value = result.result?.value;
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
}

async function snapshotStr(cdp: CDP, sessionId: string) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId);
  const lines: string[] = [];
  for (const node of nodes) {
    const role = node.role?.value || "";
    const name = node.name?.value ?? "";
    const value = node.value?.value;
    if (role === "none" || role === "generic") continue;
    if (name === "" && (value === "" || value == null)) continue;
    const depth = Math.min((node.backendDOMNodeId ? 1 : 0) + ((node.childIds?.length || 0) ? 0 : 0), 10);
    let line = `${"  ".repeat(depth)}[${role}]`;
    if (name) line += ` ${name}`;
    if (!(value === "" || value == null)) line += ` = ${JSON.stringify(value)}`;
    lines.push(line);
  }
  return lines.join("\n");
}

async function htmlStr(cdp: CDP, sessionId: string, selector?: string) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : "document.documentElement.outerHTML";
  return evalStr(cdp, sessionId, expr);
}

async function netStr(cdp: CDP, sessionId: string) {
  const raw = await evalStr(cdp, sessionId, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({ name: e.name.substring(0, 160), type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize })))`);
  return JSON.parse(raw).map((e: any) => `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${String(e.type || '').padEnd(12)}  ${e.name}`).join("\n");
}

async function clickStr(cdp: CDP, sessionId: string, selector?: string) {
  if (!selector) throw new Error("selector is required for click");
  const result = await evalStr(cdp, sessionId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok:false, error:'Element not found' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok:true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) }; })()`);
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(parsed.error);
  return `Clicked <${parsed.tag}> \"${parsed.text}\"`;
}

async function clickXyStr(cdp: CDP, sessionId: string, x?: number, y?: number) {
  if (typeof x !== "number" || typeof y !== "number") throw new Error("x and y are required for clickxy");
  const base = { x, y, button: "left", clickCount: 1, modifiers: 0 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
  await sleep(50);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId);
  return `Clicked at CSS (${x}, ${y})`;
}

async function typeStr(cdp: CDP, sessionId: string, text?: string) {
  if (!text) throw new Error("text is required for type");
  await cdp.send("Input.insertText", { text }, sessionId);
  return `Typed ${text.length} characters`;
}

async function waitForReady(cdp: CDP, sessionId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evalStr(cdp, sessionId, "document.readyState").catch(() => "");
    if (state === "complete") return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for page to finish loading");
}

async function navStr(cdp: CDP, sessionId: string, url?: string) {
  if (!url) throw new Error("url is required for nav");
  await cdp.send("Page.enable", {}, sessionId);
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", 30000);
  const result = await cdp.send("Page.navigate", { url }, sessionId);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) await loadEvent.promise;
  else loadEvent.cancel();
  await waitForReady(cdp, sessionId, 5000);
  return `Navigated to ${url}`;
}

async function reloadStr(cdp: CDP, sessionId: string) {
  await cdp.send("Page.enable", {}, sessionId);
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", 30000);
  await cdp.send("Page.reload", {}, sessionId);
  await loadEvent.promise;
  await waitForReady(cdp, sessionId, 5000);
  return "Reloaded page";
}

async function shotStr(cdp: CDP, sessionId: string, targetId: string, outputPath?: string) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const out = outputPath || resolve(RUNTIME_DIR, `screenshot-${targetId.slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, "base64"));
  const dpr = parseFloat(await evalStr(cdp, sessionId, "window.devicePixelRatio").catch(() => "1")) || 1;
  return `${out}\nScreenshot saved. DPR: ${dpr}`;
}

async function withTarget<T>(targetQuery: string | undefined, fn: (cdp: CDP, sessionId: string, page: any) => Promise<T>) {
  const cdp = await getSharedCdp();
  const pages = await getPages(cdp);
  const page = resolveTarget(pages, targetQuery);

  let sessionId = sessionCache.get(page.targetId);
  if (!sessionId) {
    const attached = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    sessionId = attached.sessionId;
    sessionCache.set(page.targetId, sessionId);
  }

  try {
    return await fn(cdp, sessionId, page);
  } catch (e: any) {
    // If Chrome invalidated a cached session, forget it so the next call re-attaches.
    if (String(e?.message || "").toLowerCase().includes("session")) {
      sessionCache.delete(page.targetId);
    }
    throw e;
  }
}

export default function chromeCdpExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    sharedCdp?.close();
    sharedCdp = undefined;
    sharedCdpPromise = undefined;
    sessionCache.clear();
  });

  pi.registerTool({
    name: "chrome_cdp",
    label: "Chrome CDP",
    description: "Inspect and control your already-open local Chrome via Chrome DevTools Protocol. Use it to list tabs, inspect DOM, evaluate JS, inspect network resources, reload, navigate, click, type, and take screenshots.",
    promptSnippet: "Inspect and control the user's live Chrome tabs via Chrome DevTools Protocol (CDP)",
    promptGuidelines: [
      "Use chrome_cdp when the user wants to inspect or control their already-open Chrome instance.",
      "Use chrome_cdp action=list before other chrome_cdp actions when you need a tab id.",
      "Use chrome_cdp action=net to inspect resource URLs loaded by the current page.",
    ],
    parameters: chromeCdpParams,
    async execute(_toolCallId, params: ChromeCdpParams) {
      if (params.action === "list") {
        const cdp = await getSharedCdp();
        const pages = await getPages(cdp);
        return {
          content: [{ type: "text", text: formatPages(pages) || "No pages found." }],
          details: { count: pages.length },
        };
      }

      const text = await withTarget(params.target, async (cdp, sessionId, page) => {
        switch (params.action) {
          case "snap": return snapshotStr(cdp, sessionId);
          case "html": return htmlStr(cdp, sessionId, params.selector);
          case "eval": return evalStr(cdp, sessionId, params.expression || "document.title");
          case "net": return netStr(cdp, sessionId);
          case "nav": return navStr(cdp, sessionId, params.url);
          case "reload": return reloadStr(cdp, sessionId);
          case "click": return clickStr(cdp, sessionId, params.selector);
          case "clickxy": return clickXyStr(cdp, sessionId, params.x, params.y);
          case "type": return typeStr(cdp, sessionId, params.text);
          case "shot": return shotStr(cdp, sessionId, page.targetId, params.outputPath);
          default: throw new Error(`Unsupported action: ${params.action}`);
        }
      });

      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: { action: params.action, target: params.target },
      };
    },
  });
}
