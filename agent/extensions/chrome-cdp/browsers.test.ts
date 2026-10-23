import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, validateLaunchArgs } from "./browsers.ts";
import chromeCdpExtension from "./index.ts";

function tools() {
  const registered = new Map<string, any>();
  let shutdown!: () => Promise<void>;
  chromeCdpExtension({
    on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    registerTool(tool: any) { registered.set(tool.name, tool); },
  } as any);
  return {
    call: (name: string, args: any, signal?: AbortSignal) => registered.get(name).execute("test", args, signal, undefined, { cwd: tmpdir() }),
    shutdown,
  };
}

describe("browser primitives", () => {
  test("list does not connect and unknown IDs never fall back", async () => {
    const manager = new BrowserManager();
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].state).toBe("not-connected");
    await expect(manager.get("missing")).rejects.toThrow("Unknown browserId");
    await expect(manager.stop("personal")).rejects.toThrow("launched");
    await manager.shutdown();
  });
  test("requires explicit browser selection", async () => {
    const t = tools();
    try {
      await expect(t.call("chrome_cdp", { action: "list" })).rejects.toThrow("browserId is required");
      const result = await t.call("chrome_browser", { action: "list" });
      expect(result.content[0].text).toContain("personal");
    } finally { await t.shutdown(); }
  });
  test("protects launch-owned switches without blocking other switches", () => {
    validateLaunchArgs(["--disable-gpu", "--window-size=1200,800", "--lang=es"]);
    for (const arg of ["--user-data-dir=x", "--remote-debugging-port=42", "--remote-debugging-pipe", "--headless", "--profile-directory=x", "https://example.com"]) {
      expect(() => validateLaunchArgs([arg])).toThrow("Unsupported");
    }
  });
  test("rejects bad endpoints and cancelled launches", async () => {
    const manager = new BrowserManager();
    await expect(manager.attach("file:///tmp/browser")).rejects.toThrow("endpoint must use");
    const controller = new AbortController(); controller.abort();
    await expect(manager.launch({}, tmpdir(), controller.signal)).rejects.toThrow("cancelled");
    await manager.shutdown();
  });
});

// Opt in: these tests launch separate Chrome processes. They never select personal.
const live = process.env.PI_CDP_LIVE_TESTS === "1" ? test : test.skip;
describe("real managed Chrome", () => {
  live("two browsers keep page state separate; attached disconnect leaves its browser open", async () => {
    const t = tools();
    const profiles: string[] = [];
    try {
      const first = (await t.call("chrome_browser", { action: "launch" })).details;
      const second = (await t.call("chrome_browser", { action: "launch" })).details;
      profiles.push(first.profilePath, second.profilePath);
      const page = await t.call("chrome_cdp", { browserId: first.browserId, action: "open", url: "data:text/html,<title>First</title><input aria-label='Search' type='search'>" });
      const target = page.details.target;
      await t.call("chrome_cdp", { browserId: first.browserId, action: "type", target, role: "searchbox", text: "hello" });
      await t.call("chrome_cdp", { browserId: first.browserId, action: "press", target, key: "Escape" });
      const value = await t.call("chrome_cdp", { browserId: first.browserId, action: "eval", target, expression: "document.querySelector('input').value" });
      expect(value.content[0].text).toBe("(no output)");
      const other = await t.call("chrome_cdp", { browserId: second.browserId, action: "list" });
      expect(other.content[0].text).not.toContain("First");
      let wrongBrowserError = "";
      try { await t.call("chrome_cdp", { browserId: second.browserId, action: "eval", target, expression: "1" }); }
      catch (error) { wrongBrowserError = String(error); }
      expect(wrongBrowserError).toContain("No tab matched");
      const [port] = readFileSync(join(first.profilePath, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
      const attached = (await t.call("chrome_browser", { action: "attach", endpoint: `http://127.0.0.1:${port}` })).details;
      await t.call("chrome_browser", { action: "disconnect", browserId: attached.browserId });
      const version = await t.call("chrome_cdp", { browserId: first.browserId, action: "raw", method: "Browser.getVersion" });
      expect(version.content[0].text).toContain("Chrome");
      await t.call("chrome_cdp", { browserId: first.browserId, action: "diagnostics", target });
      await t.call("chrome_cdp", { browserId: first.browserId, action: "close", target });
      const stopped = await t.call("chrome_browser", { action: "stop", browserId: first.browserId });
      expect(stopped.details.forced).toBe(false);
      expect(existsSync(first.profilePath)).toBe(false);
    } finally {
      await t.shutdown();
      for (const profile of profiles) expect(existsSync(profile)).toBe(false);
    }
  }, 60000);

  live("saved profiles survive stop and can be launched again", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cdp-saved-test-"));
    const manager = new BrowserManager();
    try {
      const first = await manager.launch({ profilePath: "saved" }, root);
      const marker = join(first.profilePath!, "test-marker");
      writeFileSync(marker, "retained");
      await (await manager.get(first.browserId)).send("Storage.setCookies", { cookies: [{ name: "pi-test", value: "saved", domain: "example.com", path: "/", expires: Date.now() / 1000 + 3600 }] });
      await expect(manager.launch({ profilePath: "saved" }, root)).rejects.toThrow("locked");
      await manager.stop(first.browserId);
      expect(readFileSync(marker, "utf8")).toBe("retained");
      const second = await manager.launch({ profilePath: "saved" }, root);
      expect(second.profilePath).toBe(first.profilePath);
      const { cookies } = await (await manager.get(second.browserId)).send("Storage.getCookies");
      expect(cookies.some((cookie: any) => cookie.name === "pi-test" && cookie.value === "saved")).toBe(true);
      await manager.stop(second.browserId);
    } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
  }, 60000);

  live("a profile whose browser exited can be launched again without stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cdp-exited-test-"));
    const manager = new BrowserManager();
    try {
      const first = await manager.launch({ profilePath: "saved" }, root);
      await (await manager.get(first.browserId)).send("Browser.close");
      while (manager.list().find(b => b.browserId === first.browserId)?.state !== "exited") await Bun.sleep(100);
      const second = await manager.launch({ profilePath: "saved" }, root);
      expect(manager.list().some(b => b.browserId === first.browserId)).toBe(false);
      await manager.stop(second.browserId);
    } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  live("failed launches release their profile lock without deleting saved files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cdp-stale-test-"));
    const manager = new BrowserManager();
    const portFile = join(root, "DevToolsActivePort");
    writeFileSync(portFile, "1234\n/devtools/browser/stale");
    try {
      await expect(manager.launch({ profilePath: root }, tmpdir())).rejects.toThrow("DevToolsActivePort");
      expect(existsSync(join(root, ".pi-browser-lock"))).toBe(false);
      expect(existsSync(portFile)).toBe(true);
    } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  live("shutdown cancels launches and remains safe to repeat", async () => {
    const manager = new BrowserManager();
    const launching = manager.launch({}, tmpdir());
    const outcome = launching.then(() => "launched", error => String(error));
    await manager.shutdown();
    expect(await outcome).not.toBe("launched");
    expect(manager.list()).toHaveLength(1);
    await manager.shutdown();
  }, 15000);

  live("stops the owned process tree when CDP is disconnected", async () => {
    const manager = new BrowserManager();
    try {
      const browser = await manager.launch({}, tmpdir());
      (await manager.get(browser.browserId)).close();
      const result = await manager.stop(browser.browserId);
      expect(result.forced).toBe(true);
      expect(existsSync(browser.profilePath!)).toBe(false);
    } finally { await manager.shutdown(); }
  }, 20000);
});
