import { CDP, raceWithAbort } from "./protocol.ts";

export type DiagnosticLevel = "error" | "warning" | "info" | "log";

export type DiagnosticEntry = {
  timestamp: number;
  level: DiagnosticLevel;
  source: "exception" | "console" | "log" | "network" | "page";
  message: string;
  url?: string;
  line?: number;
  column?: number;
  requestId?: string;
};

const MAX_DIAGNOSTICS_PER_TARGET = 250;

function compact(value: unknown, max = 800): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function consoleArgument(argument: any): string {
  if ("value" in (argument || {})) return compact(argument.value, 300);
  if (argument?.unserializableValue) return String(argument.unserializableValue);
  return compact(argument?.description || argument?.className || argument?.type || "", 300);
}

function consoleLevel(type: string): DiagnosticLevel {
  if (["error", "assert"].includes(type)) return "error";
  if (["warning", "warn"].includes(type)) return "warning";
  if (["log", "debug", "verbose"].includes(type)) return "log";
  return "info";
}

export class DiagnosticsStore {
  #entries = new Map<string, DiagnosticEntry[]>();
  #sessionDisposers = new Map<string, Array<() => void>>();
  #sessionTargets = new Map<string, string>();
  #initializing = new Map<string, Promise<void>>();
  #requestUrls = new Map<string, Map<string, string>>();

  #push(targetId: string, entry: DiagnosticEntry): void {
    const entries = this.#entries.get(targetId) ?? [];
    entries.push(entry);
    if (entries.length > MAX_DIAGNOSTICS_PER_TARGET) entries.splice(0, entries.length - MAX_DIAGNOSTICS_PER_TARGET);
    this.#entries.set(targetId, entries);
  }

  async ensure(cdp: CDP, sessionId: string, targetId: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    const existing = this.#initializing.get(sessionId);
    if (existing) return raceWithAbort(existing, signal);
    if (this.#sessionDisposers.has(sessionId)) return;

    const initializing = (async () => {
      const disposers: Array<() => void> = [];
      this.#sessionTargets.set(sessionId, targetId);
      const requestUrls = new Map<string, string>();
      this.#requestUrls.set(sessionId, requestUrls);
      disposers.push(cdp.onEvent("Runtime.exceptionThrown", (params) => {
        const detail = params.exceptionDetails || {};
        const frame = detail.stackTrace?.callFrames?.[0];
        this.#push(targetId, {
          timestamp: Date.now(), level: "error", source: "exception",
          message: compact(detail.exception?.description || detail.text || "Uncaught exception"),
          url: detail.url || frame?.url || undefined,
          line: typeof detail.lineNumber === "number" ? detail.lineNumber + 1 : frame?.lineNumber != null ? frame.lineNumber + 1 : undefined,
          column: typeof detail.columnNumber === "number" ? detail.columnNumber + 1 : frame?.columnNumber != null ? frame.columnNumber + 1 : undefined,
        });
      }, sessionId));
      disposers.push(cdp.onEvent("Runtime.consoleAPICalled", (params) => {
        const frame = params.stackTrace?.callFrames?.[0];
        this.#push(targetId, {
          timestamp: Date.now(), level: consoleLevel(params.type), source: "console",
          message: compact((params.args || []).map(consoleArgument).join(" ") || params.type),
          url: frame?.url || undefined,
          line: frame?.lineNumber != null ? frame.lineNumber + 1 : undefined,
          column: frame?.columnNumber != null ? frame.columnNumber + 1 : undefined,
        });
      }, sessionId));
      disposers.push(cdp.onEvent("Log.entryAdded", ({ entry }) => {
        if (!entry) return;
        this.#push(targetId, {
          timestamp: Date.now(),
          level: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
          source: "log", message: compact(entry.text || "Browser log entry"),
          url: entry.url || undefined, line: entry.lineNumber != null ? entry.lineNumber + 1 : undefined,
        });
      }, sessionId));
      disposers.push(cdp.onEvent("Network.loadingFailed", (params) => {
        const url = requestUrls.get(params.requestId);
        requestUrls.delete(params.requestId);
        this.#push(targetId, {
          timestamp: Date.now(), level: params.canceled ? "info" : "error", source: "network",
          message: compact(`${params.type || "Request"} failed: ${params.errorText || params.blockedReason || "unknown error"}`),
          requestId: params.requestId,
          url,
        });
      }, sessionId));
      disposers.push(cdp.onEvent("Network.requestWillBeSent", (params) => {
        if (params.requestId && params.request?.url) requestUrls.set(params.requestId, params.request.url);
        if (requestUrls.size > 500) {
          const oldest = requestUrls.keys().next().value;
          if (oldest) requestUrls.delete(oldest);
        }
      }, sessionId));
      disposers.push(cdp.onEvent("Network.loadingFinished", ({ requestId }) => {
        if (requestId) requestUrls.delete(requestId);
      }, sessionId));
      disposers.push(cdp.onEvent("Inspector.targetCrashed", () => {
        this.#push(targetId, { timestamp: Date.now(), level: "error", source: "page", message: "Target crashed" });
      }, sessionId));
      this.#sessionDisposers.set(sessionId, disposers);

      const enable = async (method: string) => {
        await cdp.send(method, {}, sessionId, timeoutMs);
      };
      await Promise.all([enable("Runtime.enable"), enable("Log.enable"), enable("Network.enable"), enable("Inspector.enable")]);
    })();
    const tracked = initializing.catch((error) => {
      this.disposeSession(sessionId);
      throw error;
    }).finally(() => {
      if (this.#initializing.get(sessionId) === tracked) this.#initializing.delete(sessionId);
    });
    this.#initializing.set(sessionId, tracked);
    return raceWithAbort(tracked, signal);
  }

  read(targetId: string, options: {
    includeConsoleLogs?: boolean;
    sinceMs?: number;
    levels?: DiagnosticLevel[];
    clear?: boolean;
  } = {}): DiagnosticEntry[] {
    const cutoff = options.sinceMs != null ? Date.now() - Math.max(0, options.sinceMs) : 0;
    const levels = options.levels ? new Set(options.levels) : undefined;
    const result = (this.#entries.get(targetId) ?? []).filter((entry) => {
      if (entry.timestamp < cutoff) return false;
      if (!options.includeConsoleLogs && entry.source === "console" && ["log", "info"].includes(entry.level)) return false;
      if (levels && !levels.has(entry.level)) return false;
      return true;
    });
    if (options.clear) this.#entries.delete(targetId);
    return result;
  }

  clearTarget(targetId: string): void {
    this.#entries.delete(targetId);
  }

  disposeSession(sessionId: string): void {
    for (const dispose of this.#sessionDisposers.get(sessionId) ?? []) dispose();
    this.#sessionDisposers.delete(sessionId);
    this.#sessionTargets.delete(sessionId);
    this.#requestUrls.delete(sessionId);
    this.#initializing.delete(sessionId);
  }

  disposeTarget(targetId: string): void {
    this.clearTarget(targetId);
    for (const [sessionId, sessionTargetId] of this.#sessionTargets) {
      if (sessionTargetId === targetId) this.disposeSession(sessionId);
    }
  }

  clear(): void {
    for (const sessionId of [...this.#sessionDisposers.keys()]) this.disposeSession(sessionId);
    this.#entries.clear();
    this.#initializing.clear();
    this.#requestUrls.clear();
  }
}

export function formatDiagnostics(entries: DiagnosticEntry[]): string {
  if (entries.length === 0) return "No matching diagnostics captured for this tab.";
  const lines = entries.map((entry) => {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const location = entry.url ? `  ${entry.url}${entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ""}` : ""}` : "";
    return `${time}  ${entry.level.toUpperCase().padEnd(7)}  ${entry.source.padEnd(9)}  ${entry.message}${location}`;
  });
  return `${entries.length} diagnostic entr${entries.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`;
}
