import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CDP, TargetSessionPool, abortableSleep, connectDiscoveredCdp, parseDevToolsActivePort } from "./protocol.ts";

class MockSocket {
  readyState = 0;
  onopen: ((event?: any) => void) | null = null;
  onerror: ((event?: any) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: any) => void) | null = null;
  sent: any[] = [];

  open() { this.readyState = 1; this.onopen?.({}); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function connected() {
  const socket = new MockSocket();
  const cdp = new CDP(() => socket);
  const connecting = cdp.connect("ws://test");
  socket.open();
  await connecting;
  return { cdp, socket };
}

describe("CDP protocol client", () => {
  test("routes flattened events only to the matching session", async () => {
    const { cdp, socket } = await connected();
    const seen: string[] = [];
    cdp.onEvent("Page.loadEventFired", () => seen.push("root"));
    cdp.onEvent("Page.loadEventFired", () => seen.push("A"), "session-A");
    cdp.onEvent("Page.loadEventFired", () => seen.push("B"), "session-B");

    socket.receive({ method: "Page.loadEventFired", sessionId: "session-A", params: {} });
    expect(seen).toEqual(["root", "A"]);
  });

  test("coalesces concurrent target attachments", async () => {
    const { cdp, socket } = await connected();
    const pool = new TargetSessionPool();
    const first = pool.get(cdp, "target-1");
    const second = pool.get(cdp, "target-1");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].method).toBe("Target.attachToTarget");
    socket.receive({ id: socket.sent[0].id, result: { sessionId: "session-1" } });
    expect(await Promise.all([first, second])).toEqual(["session-1", "session-1"]);
    expect(pool.size).toBe(1);
  });

  test("does not cache an attachment invalidated while it is in flight", async () => {
    const { cdp, socket } = await connected();
    const pool = new TargetSessionPool();
    const pending = pool.get(cdp, "target-stale");
    const attach = socket.sent[0];
    pool.invalidateTarget("target-stale");
    socket.receive({ id: attach.id, result: { sessionId: "session-stale" } });
    await Promise.resolve(); await Promise.resolve();
    const detach = socket.sent.find((message) => message.method === "Target.detachFromTarget");
    expect(detach).toBeDefined();
    socket.receive({ id: detach.id, result: {} });
    await expect(pending).rejects.toThrow("Discarded stale");
    expect(pool.size).toBe(0);
  });

  test("aborts pending commands and ignores late responses", async () => {
    const { cdp, socket } = await connected();
    const controller = new AbortController();
    const pending = cdp.send("Runtime.evaluate", {}, "session-A", 10_000, controller.signal);
    const id = socket.sent[0].id;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    socket.receive({ id, result: { value: true } });
  });

  test("aborts polling sleeps without leaving the timer pending", async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects pending commands when the socket disconnects", async () => {
    const { cdp, socket } = await connected();
    const pending = cdp.send("Page.reload", {}, "session-A");
    socket.close();
    await expect(pending).rejects.toThrow("WebSocket closed");
  });

  test("parses CRLF DevToolsActivePort files", () => {
    expect(parseDevToolsActivePort("9222\r\n/devtools/browser/abc\r\n", "port-file")).toEqual({
      portFile: "port-file",
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
    });
  });

  test("falls back from a stale port file to another discovered endpoint", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "cdp-protocol-test-"));
    try {
      const stale = resolve(dir, "stale");
      const live = resolve(dir, "live");
      writeFileSync(stale, "1\n/devtools/browser/stale\n");
      writeFileSync(live, "9222\n/devtools/browser/live\n");
      const attempts: string[] = [];
      const clients = [
        { async connect(url: string) { attempts.push(url); throw new Error("refused"); }, close() {} },
        { async connect(url: string) { attempts.push(url); }, close() {} },
      ];
      const connectedClient = await connectDiscoveredCdp({
        portFiles: [stale, live],
        retryDelayMs: 0,
        createClient: () => clients.shift() as unknown as CDP,
      });
      expect(connectedClient).toBeDefined();
      expect(attempts).toEqual([
        "ws://127.0.0.1:1/devtools/browser/stale",
        "ws://127.0.0.1:9222/devtools/browser/live",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
