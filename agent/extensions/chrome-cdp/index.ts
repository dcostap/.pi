import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";

const RUNTIME_DIR = resolve(tmpdir(), "pi-chrome-cdp");
mkdirSync(RUNTIME_DIR, { recursive: true });

// ── output size guards ──
const MAX_INLINE_BYTES = 2_000;   // max bytes sent to LLM inline; rest goes to files
const FIRST_LOOK_BYTES = 1_200;    // preview bytes embedded in the summary for LLM
const MAX_SNAP_LINES = 80;         // cap AX tree lines

// ── file-dumping (same pattern as web-smart-fetch) ──

function makeDumpFile(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = label.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 60);
  return resolve(RUNTIME_DIR, `cdp_${ts}_${safe}`);
}

function dumpToFile(label: string, text: string): string {
  const path = makeDumpFile(label);
  writeFileSync(path, text, "utf8");
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

async function evalStr(cdp: CDP, sessionId: string, expression: string) {
  await cdp.send("Runtime.enable", {}, sessionId);
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(formatEvalError(result.exceptionDetails, expression));
  }
  const value = result.result?.value;
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
}

async function snapshotStr(cdp: CDP, sessionId: string) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId);
  const lines: string[] = [];
  let skipped = 0;
  let total = 0;
  for (const node of nodes) {
    total++;
    const role = node.role?.value || "";
    const name = node.name?.value ?? "";
    const value = node.value?.value;
    if (role === "none" || role === "generic") { skipped++; continue; }
    if (name === "" && (value === "" || value == null)) { skipped++; continue; }
    const depth = Math.min((node.backendDOMNodeId ? 1 : 0) + ((node.childIds?.length || 0) ? 0 : 0), 10);
    let line = `${"  ".repeat(depth)}[${role}]`;
    if (name) line += ` ${name}`;
    if (!(value === "" || value == null)) line += ` = ${JSON.stringify(value)}`;
    lines.push(line);
    if (lines.length >= MAX_SNAP_LINES) break;
  }
  const header = `${lines.length} nodes shown` + (total > lines.length ? ` (${total} total, ${skipped} skipped)` : "");
  return header + "\n" + lines.join("\n");
}

async function htmlStr(cdp: CDP, sessionId: string, selector?: string) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : "document.documentElement.outerHTML";
  const raw = await evalStr(cdp, sessionId, expr);

  // HTML is always too big — dump to file, return stats + path
  let stats = "";
  try {
    const s = await evalStr(cdp, sessionId,
      `JSON.stringify({bodyChildren: document.body?.children.length??0, totalElements: document.querySelectorAll('*').length, bodyTextChars: (document.body?.textContent||'').length})`
    );
    const parsed = JSON.parse(s);
    stats = `body:${parsed.bodyChildren} kids, ${parsed.totalElements} elements, ${parsed.bodyTextChars} text chars`;
  } catch { /* best-effort */ }

  const label = selector ? `html_sel_${selector.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}` : "html_full";
  return maybeDump(label + ".html", raw, stats);
}

async function netStr(cdp: CDP, sessionId: string) {
  const raw = await evalStr(cdp, sessionId, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({ name: e.name.substring(0, 200), type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize })))`);
  const entries: any[] = JSON.parse(raw);
  if (entries.length === 0) return "No resource entries";
  const totalSize = entries.reduce((s: number, e: any) => s + (typeof e.size === "number" ? e.size : 0), 0);
  const totalMs = entries.reduce((s: number, e: any) => s + e.duration, 0);
  const summary = `${entries.length} resources, ${formatBytes(totalSize)}, ${totalMs.toFixed(0)}ms total`;
  const table = entries.map((e: any) =>
    `${String(e.duration).padStart(5)}ms  ${formatBytes(e.size).padStart(8)}  ${String(e.type || "").padEnd(12)}  ${e.name}`
  ).join("\n");
  const full = `${summary}\n${table}`;
  return maybeDump("network.txt", full, `top resources by size/type`);
}

function formatBytes(n: number | undefined | null): string {
  if (n == null || n === 0) return "   0 B";
  if (n < 1024) return `${String(n).padStart(4)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1).padStart(4)}KB`;
  return `${(n / 1048576).toFixed(1).padStart(4)}MB`;
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
  try {
    const result = await cdp.send("Page.navigate", { url }, sessionId);
    if (result.errorText) throw new Error(result.errorText);
    if (result.loaderId) await loadEvent.promise;
    await waitForReady(cdp, sessionId, 5000);
    return `Navigated to ${url}`;
  } finally {
    // If Page.navigate times out or fails before we await loadEvent.promise, cancel
    // the pending timer/listener. Otherwise its later rejection can become an
    // uncaught exception and take down pi.
    loadEvent.cancel();
  }
}

async function reloadStr(cdp: CDP, sessionId: string) {
  await cdp.send("Page.enable", {}, sessionId);
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", 30000);
  try {
    await cdp.send("Page.reload", {}, sessionId);
    await loadEvent.promise;
    await waitForReady(cdp, sessionId, 5000);
    return "Reloaded page";
  } finally {
    // Same cleanup as navStr: avoid orphaned load-event timers if reload fails.
    loadEvent.cancel();
  }
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
      "chrome_cdp dumps large outputs (>2KB) to temp files to protect context. When you see [Dumped … to C:\\...], use read with offset/limit to inspect the file instead of re-running chrome_cdp.",
    ],
    parameters: chromeCdpParams,
    async execute(_toolCallId, params: ChromeCdpParams) {
      if (params.action === "list") {
        const started = Date.now();
        const cdp = await getSharedCdp();
        const pages = await getPages(cdp);
        return {
          content: [{ type: "text", text: formatPages(pages) || "No pages found." }],
          details: { action: "list", count: pages.length, elapsedMs: Date.now() - started },
        };
      }

      const started = Date.now();
      let pageMeta: { url: string; title: string } = { url: "", title: "" };

      const text = await withTarget(params.target, async (cdp, sessionId, page) => {
        pageMeta = { url: (page as any).url as string ?? "", title: (page as any).title as string ?? "" };
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
          dumped: rawText.length > MAX_INLINE_BYTES,
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
      if (args.url) {
        const short = args.url.length > 40 ? args.url.slice(0, 40) + "…" : args.url;
        parts.push(theme.fg("dim", short));
      }
      if (args.selector) {
        parts.push(theme.fg("dim", args.selector.length > 30 ? args.selector.slice(0, 30) + "…" : args.selector));
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
        case "eval": {
          const raw = String(result.content?.[0]?.text ?? "");
          if (raw.startsWith("Eval failed:")) {
            const firstLine = raw.split("\n")[0].replace("Eval failed: ", "");
            return new Text(theme.fg("error", `\u2717 ${firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine}`), 0, 0);
          }
          const dumped = details.dumped ?? raw.includes("[Dumped ");
          if (dumped) {
            return new Text(theme.fg("info", `\u2713 eval \u2192 file (${formatBytes(details.outputBytes)})`), 0, 0);
          }
          const short = raw.length > 120 ? raw.slice(0, 120).replace(/\n/g, " \u00b7 ") + "…" : raw.replace(/\n/g, " \u00b7 ");
          return new Text(theme.fg("success", `\u2713 ${short}`), 0, 0);
        }
        case "snap": {
          const firstLine = String(result.content?.[0]?.text ?? "").split("\n")[0] || "";
          const dumped = details.dumped ?? false;
          return new Text(theme.fg(dumped ? "info" : "success", `\u2713 ${firstLine}${dumped ? " \u2192 file" : ""}`), 0, 0);
        }
        case "html": {
          const bytes = details.outputBytes ?? 0;
          const selector = details.selector;
          const dumped = details.dumped ?? false;
          return new Text(
            theme.fg(dumped ? "info" : "success", `\u2713 HTML ${formatBytes(bytes)}${selector ? ` (${selector})` : ""}${dumped ? " \u2192 file" : ""}`),
            0, 0
          );
        }
        case "net": {
          const firstLine = String(result.content?.[0]?.text ?? "").split("\n")[0] || "";
          const dumped = details.dumped ?? false;
          return new Text(theme.fg(dumped ? "info" : "success", `\u2713 ${firstLine}${dumped ? " \u2192 file" : ""}`), 0, 0);
        }
        case "nav": {
          return new Text(theme.fg("success", `\u2713 ${String(result.content?.[0]?.text ?? "")}`), 0, 0);
        }
        case "reload": {
          return new Text(theme.fg("success", `\u2713 ${String(result.content?.[0]?.text ?? "")}`), 0, 0);
        }
        case "click":
        case "clickxy": {
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
