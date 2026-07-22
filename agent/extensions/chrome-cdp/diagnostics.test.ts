import { describe, expect, test } from "bun:test";
import { DiagnosticsStore } from "./diagnostics.ts";
import type { CDP } from "./protocol.ts";

class MockDiagnosticsCdp {
  handlers = new Map<string, Set<(params: any) => void>>();
  release!: () => void;
  gate = new Promise<void>((resolve) => { this.release = resolve; });

  async send() { await this.gate; return {}; }
  onEvent(method: string, handler: (params: any) => void) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }
  emit(method: string, params: any) {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }
}

describe("diagnostics lifecycle", () => {
  test("a later caller can cancel without poisoning shared initialization", async () => {
    const cdp = new MockDiagnosticsCdp();
    const store = new DiagnosticsStore();
    const first = store.ensure(cdp as unknown as CDP, "session", "target");
    const controller = new AbortController();
    const second = store.ensure(cdp as unknown as CDP, "session", "target", 15_000, controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    cdp.release();
    await first;

    cdp.emit("Log.entryAdded", { entry: { level: "error", text: "boom", url: "https://example.test/app.js", lineNumber: 0 } });
    expect(store.read("target")[0]).toMatchObject({ message: "boom", line: 1 });
    store.clear();
  });
});
