import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadManager, formatDownload, type Download } from "./downloads.ts";
import chromeCdpExtension from "./index.ts";

let server: Server;
let url: string;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-download-test-"));
  server = createServer((req, res) => {
    if (req.url === "/fail") { res.writeHead(403); res.end("no"); return; }
    if (req.url === "/fast") { res.setHeader("content-length", "5"); res.end("hello"); return; }
    if (req.url === "/short") { res.setHeader("content-length", "100"); res.end("short"); return; }
    if (req.url !== "/unknown") res.setHeader("content-length", "40");
    res.write("12345");
    let count = 1;
    const timer = setInterval(() => {
      res.write("12345");
      if (++count === 8) { clearInterval(timer); res.end(); }
    }, 400);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function start(manager: DownloadManager, name: string, route = "/fast", timeoutMs?: number) {
  return manager.start({ browserId: "browser-test", url: url + route, outputPath: join(root, name), timeoutMs });
}

describe("managed downloads", () => {
  test("streams to a private partial file, then replaces the destination", async () => {
    const manager = new DownloadManager();
    const job = start(manager, "fast.txt");
    const done = await manager.wait(job.id, job.browserId, 3000);
    expect(done.state).toBe("complete");
    expect(done.bytes).toBe(5);
    expect(done.total).toBe(5);
    expect(readFileSync(done.outputPath, "utf8")).toBe("hello");
    expect(readdirSync(root).some(name => name.includes(job.id))).toBe(false);
    await manager.shutdown();
  });

  test("interrupted waits preserve transfers; cancellation preserves existing files", async () => {
    const notices: Download[] = [];
    const manager = new DownloadManager(() => {}, d => notices.push(d));
    writeFileSync(join(root, "cancel.txt"), "original");
    const job = start(manager, "cancel.txt", "/slow");
    manager.background(job.id, job.browserId);
    await manager.wait(job.id, job.browserId, 100);
    expect(manager.get(job.id, job.browserId).bytes).toBeGreaterThan(0);
    expect(() => start(manager, "cancel.txt")).toThrow("already writes");
    const controller = new AbortController();
    controller.abort();
    expect((await manager.wait(job.id, job.browserId, 10000, controller.signal)).state).toBe("running");
    expect(() => manager.get(job.id, "other-browser")).toThrow("No download");
    const result = await manager.cancel(job.id, job.browserId);
    expect(result.state).toBe("cancelled");
    expect(readFileSync(job.outputPath, "utf8")).toBe("original");
    expect(readdirSync(root).some(name => name.includes(job.id))).toBe(false);
    expect(notices).toHaveLength(1);
    await manager.shutdown();
  });

  test("unknown lengths omit totals and time estimates", async () => {
    const manager = new DownloadManager();
    const job = start(manager, "unknown.txt", "/unknown");
    const pending = await manager.wait(job.id, job.browserId, 100);
    expect(pending.total).toBeUndefined();
    expect(formatDownload(pending)).not.toContain("left");
    expect(formatDownload(pending)).toContain("/s");
    await manager.shutdown();
    expect(manager.get(job.id, job.browserId).state).toBe("cancelled");
    expect(existsSync(job.outputPath)).toBe(false);
  });

  test("HTTP errors and explicit deadlines fail without destination files", async () => {
    const manager = new DownloadManager();
    for (const [name, route, timeout] of [["http.txt", "/fail", 1000], ["timeout.txt", "/slow", 80], ["short.txt", "/short", 100]] as const) {
      const job = start(manager, name, route, timeout);
      const done = await manager.wait(job.id, job.browserId, 2000);
      expect(done.state).toBe("failed");
      expect(existsSync(done.outputPath)).toBe(false);
      expect(readdirSync(root).some(name => name.includes(job.id))).toBe(false);
    }
    await manager.shutdown();
  });

  test("tool returns slow jobs after two seconds and sends completion once", async () => {
    const handlers = new Map<string, any>();
    const messages: any[] = [];
    let tool: any;
    chromeCdpExtension({
      on(name: string, fn: any) { handlers.set(name, fn); },
      registerTool(value: any) { if (value.name === "chrome_cdp") tool = value; },
      sendMessage(message: any) { messages.push(message); },
      events: { emit() {} },
    } as any);
    const ctx = { cwd: root };
    try {
      const begin = Date.now();
      const result = await tool.execute("start", { action: "download", browserId: "test", url: url + "/slow", outputPath: "tool.txt" }, undefined, undefined, ctx);
      expect(Date.now() - begin).toBeLessThan(2600);
      expect(result.details.download.state).toBe("running");
      const downloadId = result.details.download.id;
      const done = await tool.execute("wait", { action: "download_wait", browserId: "test", downloadId, timeoutMs: 3000 }, undefined, undefined, ctx);
      expect(done.details.download.state).toBe("complete");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("40 B");
      expect(readFileSync(join(root, "tool.txt"), "utf8")).toBe("12345".repeat(8));
    } finally { await handlers.get("session_shutdown")(); }
  });

  test("steering interrupts the initial wait, not the download", async () => {
    const handlers = new Map<string, any>();
    let tool: any;
    chromeCdpExtension({
      on(name: string, fn: any) { handlers.set(name, fn); },
      registerTool(value: any) { if (value.name === "chrome_cdp") tool = value; },
      sendMessage() {}, events: { emit() {} },
    } as any);
    try {
      const pending = tool.execute("start", { action: "download", browserId: "test", url: url + "/slow", outputPath: "steer.txt" }, undefined, undefined, { cwd: root });
      handlers.get("input")({ streamingBehavior: "steer" });
      const result = await pending;
      expect(result.details.download.state).toBe("running");
    } finally { await handlers.get("session_shutdown")(); }
    expect(existsSync(join(root, "steer.txt"))).toBe(false);
  });
});
