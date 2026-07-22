import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export class CdpAbortError extends Error {
  constructor(message = "Chrome CDP operation cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CdpAbortError();
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => rejectPromise(new CdpAbortError()));
    const timer = setTimeout(() => finish(resolvePromise), Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => rejectPromise(new CdpAbortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
};

type EventSubscription = {
  sessionId?: string;
  handler: (params: any) => void;
};

type WebSocketLike = {
  readyState: number;
  onopen: ((event?: any) => void) | null;
  onerror: ((event?: any) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: any) => void) | null;
  send(data: string): void;
  close(): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export class CDP {
  #ws?: WebSocketLike;
  #id = 0;
  #closed = true;
  #closeNotified = false;
  #pending = new Map<number, PendingRequest>();
  #handlers = new Map<string, Set<EventSubscription>>();
  #closeHandlers = new Set<() => void>();
  readonly #createWebSocket: WebSocketFactory;

  constructor(createWebSocket: WebSocketFactory = (url) => new WebSocket(url)) {
    this.#createWebSocket = createWebSocket;
  }

  get isOpen(): boolean {
    return !!this.#ws && !this.#closed && this.#ws.readyState === 1;
  }

  async connect(wsUrl: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = this.#createWebSocket(wsUrl);
      this.#ws = ws;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectConnect = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#closed = true;
        try { ws.close(); } catch { /* best effort */ }
        rejectPromise(error);
      };
      const onAbort = () => rejectConnect(new CdpAbortError());
      const timer = setTimeout(
        () => rejectConnect(new Error(`WebSocket connection timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#closed = false;
        this.#closeNotified = false;
        resolvePromise();
      };
      ws.onerror = (event: any) => rejectConnect(new Error(`WebSocket error: ${event?.message || event?.type || "unknown"}`));
      ws.onmessage = (event) => this.#handleMessage(event.data);
      ws.onclose = () => {
        if (!settled) rejectConnect(new Error("WebSocket closed before the connection was established"));
        this.#handleClose();
      };
    });
  }

  #handleMessage(data: unknown): void {
    let message: any;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (message.id && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)!;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
      else pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    for (const subscription of this.#handlers.get(message.method) ?? []) {
      if (subscription.sessionId !== undefined && subscription.sessionId !== message.sessionId) continue;
      try { subscription.handler(message.params || {}); } catch { /* isolate event consumers */ }
    }
  }

  #handleClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(new Error(`WebSocket closed while waiting for response ${id}`));
    }
    this.#pending.clear();
    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* isolate close consumers */ }
    }
  }

  send(method: string, params: any = {}, sessionId?: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<any> {
    try { throwIfAborted(signal); } catch (error) { return Promise.reject(error); }
    if (!this.isOpen) return Promise.reject(new Error(`CDP connection is not open (cannot send ${method})`));

    const id = ++this.#id;
    return new Promise<any>((resolvePromise, rejectPromise) => {
      const settleError = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        rejectPromise(error);
      };
      const timer = setTimeout(
        () => settleError(new Error(`Timeout: ${method} after ${timeoutMs}ms`)),
        timeoutMs,
      );
      let removeAbort: (() => void) | undefined;
      if (signal) {
        const onAbort = () => settleError(new CdpAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, removeAbort });

      const message: any = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.#ws!.send(JSON.stringify(message));
      } catch (error: any) {
        settleError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(method: string, handler: (params: any) => void, sessionId?: string): () => void {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    const subscription = { sessionId, handler };
    this.#handlers.get(method)!.add(subscription);
    return () => {
      const subscriptions = this.#handlers.get(method);
      subscriptions?.delete(subscription);
      if (subscriptions?.size === 0) this.#handlers.delete(method);
    };
  }

  waitForEvent(method: string, timeoutMs = 15_000, sessionId?: string, signal?: AbortSignal) {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let removeAbort: (() => void) | undefined;
    let rejectWait: ((error: Error) => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      off?.();
      removeAbort?.();
    };
    const promise = new Promise<any>((resolvePromise, rejectPromise) => {
      rejectWait = rejectPromise;
      try { throwIfAborted(signal); } catch (error: any) { settled = true; rejectPromise(error); return; }
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(params);
      }, sessionId);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(`Timeout waiting for event: ${method}`));
      }, timeoutMs);
      if (signal) {
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(new CdpAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    });

    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        cleanup();
        // Cancellation is cleanup-only for navigation paths that deliberately
        // stop waiting; do not create an unhandled rejection.
        rejectWait = undefined;
      },
    };
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  close(): void {
    try { this.#ws?.close(); } catch { /* best effort */ }
    this.#handleClose();
  }
}

export type WsCandidate = { portFile: string; wsUrl: string };

export function getPortFileCandidates(): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || resolve(home, "AppData", "Local");
  const macBrowsers = [
    "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Google/Chrome for Testing",
    "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge",
  ];
  const linuxBrowsers = [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium",
    "vivaldi", "vivaldi-snapshot", "BraveSoftware/Brave-Browser", "microsoft-edge",
  ];
  const flatpakBrowsers = [
    ["org.chromium.Chromium", "chromium"],
    ["com.google.Chrome", "google-chrome"],
    ["com.brave.Browser", "BraveSoftware/Brave-Browser"],
    ["com.microsoft.Edge", "microsoft-edge"],
    ["com.vivaldi.Vivaldi", "vivaldi"],
  ];
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...macBrowsers.flatMap((browser) => [
      resolve(home, "Library", "Application Support", browser, "DevToolsActivePort"),
      resolve(home, "Library", "Application Support", browser, "Default", "DevToolsActivePort"),
    ]),
    ...linuxBrowsers.flatMap((browser) => [
      resolve(home, ".config", browser, "DevToolsActivePort"),
      resolve(home, ".config", browser, "Default", "DevToolsActivePort"),
    ]),
    ...flatpakBrowsers.flatMap(([appId, browser]) => [
      resolve(home, ".var", "app", appId, "config", browser, "DevToolsActivePort"),
      resolve(home, ".var", "app", appId, "config", browser, "Default", "DevToolsActivePort"),
    ]),
    resolve(local, "Google", "Chrome", "User Data", "DevToolsActivePort"),
    resolve(local, "Google", "Chrome", "User Data", "Default", "DevToolsActivePort"),
    resolve(local, "Google", "Chrome Beta", "User Data", "DevToolsActivePort"),
    resolve(local, "Google", "Chrome SxS", "User Data", "DevToolsActivePort"),
    resolve(local, "Google", "Chrome for Testing", "User Data", "DevToolsActivePort"),
    resolve(local, "Chromium", "User Data", "DevToolsActivePort"),
    resolve(local, "BraveSoftware", "Brave-Browser", "User Data", "DevToolsActivePort"),
    resolve(local, "Microsoft", "Edge", "User Data", "DevToolsActivePort"),
  ].filter(Boolean) as string[];
  return [...new Set(candidates)];
}

export function parseDevToolsActivePort(text: string, portFile: string, host = process.env.CDP_HOST || "127.0.0.1"): WsCandidate {
  const [port, wsPath] = text.trim().split(/\r?\n/);
  if (!port || !/^\d+$/.test(port) || !wsPath?.startsWith("/")) {
    throw new Error(`Invalid DevToolsActivePort contents: ${portFile}`);
  }
  return { portFile, wsUrl: `ws://${host}:${port}${wsPath}` };
}

export function discoverWsCandidates(portFiles = getPortFileCandidates()) {
  const candidates: WsCandidate[] = [];
  const invalid: string[] = [];
  for (const portFile of portFiles) {
    if (!existsSync(portFile)) continue;
    try {
      candidates.push(parseDevToolsActivePort(readFileSync(portFile, "utf8"), portFile));
    } catch (error: any) {
      invalid.push(`${portFile} (${error?.message || String(error)})`);
    }
  }
  return { candidates, invalid, searched: portFiles };
}

export function chromeSetupHint(): string {
  return "Open chrome://inspect/#remote-debugging in Chrome, enable Allow remote debugging, accept the confirmation, then retry.";
}

export async function connectDiscoveredCdp(options: {
  signal?: AbortSignal;
  portFiles?: string[];
  createClient?: () => CDP;
  retryDelayMs?: number;
} = {}): Promise<CDP> {
  const failures: string[] = [];
  const createClient = options.createClient ?? (() => new CDP());
  let discovery = discoverWsCandidates(options.portFiles);

  for (let pass = 0; pass < 2; pass++) {
    throwIfAborted(options.signal);
    if (pass > 0) {
      await abortableSleep(options.retryDelayMs ?? 250, options.signal);
      discovery = discoverWsCandidates(options.portFiles);
    }
    const seenUrls = new Set<string>();
    for (const candidate of discovery.candidates) {
      if (seenUrls.has(candidate.wsUrl)) continue;
      seenUrls.add(candidate.wsUrl);
      const cdp = createClient();
      try {
        await cdp.connect(candidate.wsUrl, 15_000, options.signal);
        return cdp;
      } catch (error: any) {
        cdp.close();
        if (error?.name === "AbortError") throw error;
        failures.push(`${candidate.portFile}: ${error?.message || String(error)}`);
      }
    }
  }

  if (discovery.candidates.length === 0) {
    const invalid = discovery.invalid.length ? ` Invalid files: ${discovery.invalid.join("; ")}.` : "";
    throw new Error(`Chrome remote debugging is not available. ${chromeSetupHint()}${invalid}\nSearched: ${discovery.searched.join(", ")}`);
  }
  throw new Error(`Could not connect to Chrome; the discovered DevToolsActivePort endpoint may be stale. ${chromeSetupHint()}\nTried:\n${failures.join("\n")}`);
}

export class TargetSessionPool {
  #sessions = new Map<string, string>();
  #attachments = new Map<string, { promise: Promise<string>; epoch: number; generation: number }>();
  #targetGenerations = new Map<string, number>();
  #epoch = 0;

  async get(cdp: CDP, targetId: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const cached = this.#sessions.get(targetId);
    if (cached) return cached;

    const epoch = this.#epoch;
    const generation = this.#targetGenerations.get(targetId) ?? 0;
    let attachment = this.#attachments.get(targetId);
    if (!attachment || attachment.epoch !== epoch || attachment.generation !== generation) {
      const promise = cdp.send("Target.attachToTarget", { targetId, flatten: true }).then(async (result) => {
        const sessionId = String(result.sessionId || "");
        if (!sessionId) throw new Error(`Chrome did not return a session id for target ${targetId}`);
        if (this.#epoch !== epoch || (this.#targetGenerations.get(targetId) ?? 0) !== generation) {
          await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 5_000).catch(() => {});
          throw new Error(`Discarded stale Chrome session attachment for target ${targetId}`);
        }
        this.#sessions.set(targetId, sessionId);
        return sessionId;
      });
      attachment = { promise, epoch, generation };
      this.#attachments.set(targetId, attachment);
      void promise.finally(() => {
        if (this.#attachments.get(targetId) === attachment) this.#attachments.delete(targetId);
      }).catch(() => {});
    }
    return raceWithAbort(attachment.promise, signal);
  }

  invalidateTarget(targetId: string): void {
    this.#sessions.delete(targetId);
    this.#attachments.delete(targetId);
    this.#targetGenerations.set(targetId, (this.#targetGenerations.get(targetId) ?? 0) + 1);
  }

  invalidateSession(sessionId: string): void {
    for (const [targetId, cachedSessionId] of this.#sessions) {
      if (cachedSessionId === sessionId) this.invalidateTarget(targetId);
    }
  }

  clear(): void {
    this.#epoch++;
    this.#sessions.clear();
    this.#attachments.clear();
    this.#targetGenerations.clear();
  }

  get size(): number {
    return this.#sessions.size;
  }
}
