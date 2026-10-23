import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, openSync, closeSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { delimiter, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CDP, abortableSleep, connectDiscoveredCdp, parseDevToolsActivePort, raceWithAbort, throwIfAborted } from "./protocol.ts";

export type LaunchOptions = {
  executablePath?: string;
  profilePath?: string;
  headless?: boolean;
  args?: string[];
  url?: string;
  timeoutMs?: number;
};

type Browser = {
  browserId: string;
  ownership: "launched" | "attached";
  state: "running" | "exited" | "disconnected";
  cdp?: CDP;
  endpoint?: string;
  process?: ChildProcess;
  exitCode?: number | null;
  profilePath?: string;
  temporary?: boolean;
  headless?: boolean;
  executablePath?: string;
  lockPath?: string;
  cwd?: string;
};

export function findBrowser(explicit?: string, cwd = homedir()): string {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new Error(`Browser executable not found: ${path}`);
    return path;
  }
  const local = process.env.LOCALAPPDATA || resolve(homedir(), "AppData/Local");
  const candidates = process.platform === "win32" ? [
    ...[process.env.PROGRAMFILES || "C:/Program Files", process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", local]
      .flatMap(root => [resolve(root, "Google/Chrome/Application/chrome.exe"), resolve(root, "Microsoft/Edge/Application/msedge.exe")]),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : (process.env.PATH || "").split(delimiter).flatMap(root => ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(name => join(root, name)));
  const path = candidates.find(path => existsSync(path));
  if (!path) throw new Error("No Chrome-compatible browser found. Supply executablePath.");
  return path;
}

export function validateLaunchArgs(args: string[]) {
  for (const arg of args) {
    if (!arg.startsWith("--") || /^--(?:user-data-dir|remote-debugging[^=]*|headless|profile-directory)(?:=|$)/i.test(arg)) {
      throw new Error(`Unsupported launch argument: ${arg}. Use the dedicated launch options; debugging settings belong to Pi.`);
    }
  }
}

function isAlive(b: Browser): boolean {
  return !!b.process?.pid && b.process.exitCode === null && b.process.signalCode === null && b.state !== "exited";
}

async function waitForExit(b: Browser, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(b) && Date.now() < deadline) await abortableSleep(100);
}

function killProcessTree(b: Browser): Promise<void> {
  const pid = b.process!.pid!;
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const taskkill = resolve(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { cwd: b.cwd, windowsHide: true, stdio: "ignore", timeout: 5000 });
    killer.on("error", rejectPromise);
    killer.on("exit", code => {
      if (code === 0 || !isAlive(b)) resolvePromise();
      else rejectPromise(new Error(`taskkill failed (${code}); profile retained.`));
    });
  });
}

export class BrowserManager {
  private browsers = new Map<string, Browser>();
  private personal?: CDP;
  private personalConnecting?: Promise<CDP>;
  private personalController?: AbortController;
  private personalWaiters = 0;
  private active = new Set<Promise<unknown>>();
  private stopping = new Map<string, Promise<unknown>>();
  private stopped = false;
  private lifetime = new AbortController();
  private shutdownPromise?: Promise<void>;

  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }

  private check() {
    if (this.stopped) throw new Error("Browser manager is shutting down.");
  }

  private withLifetime(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }

  list() {
    return [
      { browserId: "personal", ownership: "attached", state: this.personal?.isOpen ? "connected" : "not-connected", discovery: "local Chrome profile discovery; connects only when selected" },
      ...[...this.browsers.values()].map(b => this.describe(b)),
    ];
  }

  private describe(b: Browser) {
    return {
      browserId: b.browserId,
      ownership: b.ownership,
      state: b.state,
      connected: !!b.cdp?.isOpen,
      endpoint: b.endpoint,
      pid: b.process?.pid,
      profilePath: b.profilePath,
      temporary: b.temporary,
      headless: b.headless,
      executablePath: b.executablePath,
      exitCode: b.exitCode,
    };
  }

  async get(id: string, signal?: AbortSignal): Promise<CDP> {
    this.check();
    throwIfAborted(signal);
    if (id === "personal") return this.getPersonal(signal);
    const b = this.browsers.get(id);
    if (!b) throw new Error(`Unknown browserId: ${id}. Use chrome_browser action=list.`);
    if (!b.cdp?.isOpen) throw new Error(`Browser ${id} is ${b.state}. Attach again or launch another browser.`);
    return b.cdp;
  }

  private async getPersonal(signal?: AbortSignal): Promise<CDP> {
    if (this.personal?.isOpen) return this.personal;
    if (!this.personalConnecting) {
      const controller = new AbortController();
      this.personalController = controller;
      const connecting = connectDiscoveredCdp({ signal: controller.signal }).then(cdp => {
        if (this.stopped || controller.signal.aborted) {
          cdp.close();
          throw new Error("Browser connection was cancelled.");
        }
        return this.personal = cdp;
      }).finally(() => {
        if (this.personalConnecting === connecting) this.personalConnecting = undefined;
      });
      this.personalConnecting = this.track(connecting);
    }
    this.personalWaiters++;
    try {
      return await raceWithAbort(this.personalConnecting, signal);
    } finally {
      this.personalWaiters--;
      if (!this.personalWaiters && signal?.aborted) this.personalController?.abort();
    }
  }

  attach(endpoint: string, signal?: AbortSignal) { return this.track(this.attachImpl(endpoint, signal)); }

  private async attachImpl(endpoint: string, callerSignal?: AbortSignal) {
    this.check();
    const signal = this.withLifetime(callerSignal);
    const url = new URL(endpoint);
    let ws = endpoint;
    if (["http:", "https:"].includes(url.protocol)) {
      const response = await fetch(new URL("/json/version", url), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
      ws = (await response.json() as any).webSocketDebuggerUrl;
    } else if (!["ws:", "wss:"].includes(url.protocol)) {
      throw new Error("endpoint must use http, https, ws, or wss.");
    }
    if (typeof ws !== "string" || !/^wss?:\/\//.test(ws)) throw new Error("Endpoint did not return a browser WebSocket URL.");
    const cdp = new CDP();
    try {
      await cdp.connect(ws, 15000, signal);
      await cdp.send("Browser.getVersion", {}, undefined, 15000, signal);
      this.check();
      const b: Browser = { browserId: `browser-${randomUUID().slice(0, 8)}`, ownership: "attached", endpoint: ws, cdp, state: "running" };
      cdp.onClose(() => { b.state = "disconnected"; });
      this.browsers.set(b.browserId, b);
      return this.describe(b);
    } catch (error) {
      cdp.close();
      throw error;
    }
  }

  launch(options: LaunchOptions, cwd: string, signal?: AbortSignal) { return this.track(this.launchImpl(options, cwd, signal)); }

  private async launchImpl(options: LaunchOptions, cwd: string, callerSignal?: AbortSignal) {
    this.check();
    const signal = this.withLifetime(callerSignal);
    throwIfAborted(signal);
    validateLaunchArgs(options.args || []);
    if (options.url?.startsWith("-")) throw new Error("url must not be a browser switch.");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 600000)) {
      throw new Error("timeoutMs must be between 100 and 600000.");
    }
    const executablePath = findBrowser(options.executablePath, cwd);
    const temporary = !options.profilePath;
    const profilePath = temporary ? mkdtempSync(join(tmpdir(), "pi-chrome-profile-")) : resolve(cwd, options.profilePath!);
    mkdirSync(profilePath, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(profilePath);
    const owner = [...this.browsers.values()].find(b => b.profilePath === canonical);
    // A closed window leaves its profile locked until stop. Release it for the next launch.
    if (owner && owner.state === "exited") await this.stop(owner.browserId);
    const lockPath = join(canonical, ".pi-browser-lock");
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const hint = owner && owner.state !== "exited"
        ? `Stop its browser first: chrome_browser action=stop browserId=${owner.browserId}.`
        : "Remove .pi-browser-lock only after checking that its browser has stopped.";
      throw new Error(`Profile is locked: ${canonical}. ${hint}`);
    }
    const b: Browser = {
      browserId: `browser-${randomUUID().slice(0, 8)}`, ownership: "launched", state: "running",
      profilePath: canonical, temporary, headless: options.headless ?? true, executablePath, lockPath, cwd,
    };
    this.browsers.set(b.browserId, b);
    let stderr = "";
    let spawnError: Error | undefined;
    try {
      // Never consume an endpoint left by another process using this profile.
      const portFile = join(canonical, "DevToolsActivePort");
      if (existsSync(portFile)) throw new Error(`Profile has DevToolsActivePort: ${canonical}. Use attach, or remove the stale file after checking its browser has stopped.`);
      b.process = spawn(executablePath, [
        `--user-data-dir=${canonical}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", ...(b.headless ? ["--headless=new"] : []),
        ...(options.args || []), options.url || "about:blank",
      ], { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: b.headless, detached: process.platform !== "win32" });
      b.process.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      b.process.on("error", error => { spawnError = error; b.state = "exited"; });
      b.process.on("exit", code => { b.state = "exited"; b.exitCode = code; b.cdp?.close(); });
      const deadline = Date.now() + (options.timeoutMs ?? 30000);
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        this.check();
        if (spawnError) throw spawnError;
        if (b.state === "exited") throw new Error(`Browser exited before CDP was ready (${b.exitCode}). ${stderr}`);
        if (existsSync(portFile)) {
          let candidate;
          try { candidate = parseDevToolsActivePort(readFileSync(portFile, "utf8"), portFile, "127.0.0.1"); }
          catch { await abortableSleep(100, signal); continue; }
          b.endpoint = candidate.wsUrl;
          const cdp = new CDP();
          b.cdp = cdp;
          await cdp.connect(candidate.wsUrl, Math.max(100, deadline - Date.now()), signal);
          await cdp.send("Browser.getVersion", {}, undefined, 5000, signal);
          this.check();
          cdp.onClose(() => { if (b.state !== "exited") b.state = "disconnected"; });
          return this.describe(b);
        }
        await abortableSleep(100, signal);
      }
      throw new Error(`Browser launch timed out. ${stderr}`);
    } catch (error) {
      try {
        await this.stop(b.browserId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Browser launch failed: ${String(error)}. Cleanup failed: ${String(cleanupError)}`);
      }
      throw error;
    }
  }

  async disconnect(id: string) {
    if (id === "personal") {
      this.personalController?.abort();
      this.personal?.close();
      this.personal = undefined;
      return { browserId: id, state: "disconnected" };
    }
    const b = this.browsers.get(id);
    if (!b) throw new Error(`Unknown browserId: ${id}`);
    if (b.ownership === "launched") throw new Error("Use stop for a launched browser. Disconnect applies to attached browsers.");
    b.cdp?.close();
    this.browsers.delete(id);
    return { browserId: id, state: "disconnected" };
  }

  stop(id: string): Promise<any> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const stopping = this.stopImpl(id).finally(() => { this.stopping.delete(id); });
    this.stopping.set(id, stopping);
    return stopping;
  }

  private async stopImpl(id: string) {
    const b = this.browsers.get(id);
    if (!b || b.ownership !== "launched") throw new Error("stop requires a browser launched by this session. Use disconnect for attached browsers.");
    let forced = false;
    if (isAlive(b)) {
      await b.cdp?.send("Browser.close", {}, undefined, 2000).catch(() => {});
      await waitForExit(b, 4000);
    }
    if (isAlive(b)) {
      forced = true;
      await killProcessTree(b);
      await waitForExit(b, 4000);
      if (isAlive(b)) throw new Error(`Could not stop browser ${id} (PID ${b.process!.pid}). Profile retained.`);
    }
    b.cdp?.close();
    if (b.lockPath) rmSync(b.lockPath, { force: true });
    if (b.temporary && b.profilePath) rmSync(b.profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    // A stopped persistent profile can be launched again without a stale endpoint.
    if (!b.temporary && b.profilePath && b.process?.pid) rmSync(join(b.profilePath, "DevToolsActivePort"), { force: true });
    this.browsers.delete(id);
    return { browserId: id, state: "stopped", forced, profileRetained: !b.temporary };
  }

  shutdown(): Promise<void> {
    return this.shutdownPromise ??= this.shutdownImpl();
  }

  private async shutdownImpl() {
    this.stopped = true;
    this.lifetime.abort();
    this.personalController?.abort();
    this.personal?.close();
    await Promise.allSettled([...this.active]);
    const results = await Promise.allSettled([...this.browsers.values()].map(b => b.ownership === "launched" ? this.stop(b.browserId) : this.disconnect(b.browserId)));
    const errors = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    if (errors.length) throw new Error(errors.map(r => String(r.reason)).join("; "));
  }
}
