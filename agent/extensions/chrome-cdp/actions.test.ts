import { describe, expect, test } from "bun:test";
import chromeCdpExtension, { __testing } from "./index.ts";
import type { CDP } from "./protocol.ts";

const metadata = {
  tag: "BUTTON", id: "run", classes: [], role: "button", name: "Run", text: "Run",
  attributes: {}, rect: { x: 10, y: 20, width: 80, height: 30, top: 20, right: 90, bottom: 50, left: 10 },
  pageRect: { x: 10, y: 20, width: 80, height: 30 }, connected: true, disabled: false,
  editable: false, visible: true, pointerEvents: "auto", opacity: "1", focused: false,
};

class MockActionCdp {
  calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  currentValue = "old";
  focusOk = true;

  async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    this.calls.push({ method, params, sessionId });
    if (method === "Runtime.evaluate") {
      if (String(params.expression).includes("const locator =")) return { result: { objectId: "object-1", subtype: "node" } };
      if (String(params.expression).includes("document.readyState")) return { result: { value: "complete" } };
      return { result: { value: true } };
    }
    if (method === "DOM.describeNode") return { node: { backendNodeId: 7, nodeId: 9 } };
    if (method === "Runtime.callFunctionOn") {
      const fn = String(params.functionDeclaration);
      if (fn.includes("function(clearFirst")) {
        return { result: { value: { ok: true, tag: "TEXTAREA", editable: true, crossOriginFrame: false, before: this.currentValue } } };
      }
      if (fn.includes("elementFromPoint")) {
        return { result: { value: { ok: true, x: 50, y: 35, tag: "BUTTON", text: "Run" } } };
      }
      if (fn.includes("Element could not be focused")) {
        return { result: { value: this.focusOk ? { ok: true } : { ok: false, error: "Element could not be focused" } } };
      }
      if (fn.includes("const normalize")) {
        return { result: { value: { ...metadata, tag: "TEXTAREA", editable: true, value: this.currentValue } } };
      }
      return { result: { value: true } };
    }
    if (method === "Input.insertText") { this.currentValue = params.text; return {}; }
    if (method === "Page.navigate") return { loaderId: "loader-1" };
    return {};
  }

  waitForEvent() {
    return { promise: Promise.resolve({}), cancel() {} };
  }
}

class ControlledNavigationCdp extends MockActionCdp {
  loadResolvers: Array<() => void> = [];
  waitForEvent() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.loadResolvers.push(resolve);
    return { promise, cancel() {} };
  }
}

describe("first-class CDP actions", () => {
  test("registers without adding an authorization command", () => {
    let commandCount = 0;
    let tool: any;
    chromeCdpExtension({
      on() {}, registerCommand() { commandCount++; }, registerTool(definition: any) { tool = definition; },
    } as any);
    expect(commandCount).toBe(0);
    expect(tool.name).toBe("chrome_cdp");
  });

  test("raw commands use browser root or target session without confirmation gates", async () => {
    const mock = new MockActionCdp();
    await __testing.rawStr(mock as unknown as CDP, "session-A", "Browser.getVersion");
    await __testing.rawStr(mock as unknown as CDP, "session-A", "Runtime.evaluate", { expression: "1" });
    expect(mock.calls.find((call) => call.method === "Browser.getVersion")?.sessionId).toBeUndefined();
    expect(mock.calls.find((call) => call.method === "Runtime.evaluate")?.sessionId).toBe("session-A");
  });

  test("trusted click uses Input.dispatchMouseEvent and honors a post-action wait", async () => {
    const mock = new MockActionCdp();
    const clicked = await __testing.clickStr(mock as unknown as CDP, "session-A", { role: "button", name: "Run" }, {});
    expect(clicked).toContain("Clicked <BUTTON>");
    const waited = await __testing.waitStr(mock as unknown as CDP, "session-A", { expression: "window.clicked", timeoutMs: 500 });
    expect(waited).toContain("truthy");
    expect(mock.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type)).toEqual([
      "mouseMoved", "mousePressed", "mouseReleased",
    ]);
  });

  test("selector-targeted typing focuses, clears, inserts, and verifies", async () => {
    const mock = new MockActionCdp();
    const result = await __testing.typeStr(mock as unknown as CDP, "session-A", { role: "textbox", name: "Message" }, {
      text: "new value", clearFirst: true,
    });
    expect(result).toContain('value is now "new value"');
    expect(mock.calls.some((call) => call.method === "Input.insertText" && call.params.text === "new value")).toBe(true);
    expect(mock.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  test("clear-first typing accepts re-entering the original value", async () => {
    const mock = new MockActionCdp();
    const result = await __testing.typeStr(mock as unknown as CDP, "session-A", { role: "textbox" }, {
      text: "old", clearFirst: true,
    });
    expect(result).toContain('value is now "old"');
  });

  test("press refuses to send keys when its locator cannot be focused", async () => {
    const mock = new MockActionCdp();
    mock.focusOk = false;
    await expect(__testing.pressStr(mock as unknown as CDP, "session-A", { role: "button", name: "Run" }, { key: "Enter" }))
      .rejects.toThrow("could not be focused");
    expect(mock.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  test("navigation and reload wait on their own session and run post waits", async () => {
    const nav = new MockActionCdp();
    const navResult = await __testing.navStr(nav as unknown as CDP, "session-nav", {
      url: "https://example.test", waitExpression: "window.ready", timeoutMs: 1000,
    });
    expect(navResult).toContain("Wait expression became truthy");
    expect(nav.calls.some((call) => call.method === "Page.navigate")).toBe(true);

    const reload = new MockActionCdp();
    const reloadResult = await __testing.reloadStr(reload as unknown as CDP, "session-reload", {
      waitExpression: "window.ready", timeoutMs: 1000,
    });
    expect(reloadResult).toContain("Wait expression became truthy");
    expect(reload.calls.some((call) => call.method === "Page.reload")).toBe(true);
  });

  test("serializes concurrent navigations within one target session", async () => {
    const mock = new ControlledNavigationCdp();
    const first = __testing.navStr(mock as unknown as CDP, "shared-session", { url: "https://one.test" });
    const second = __testing.navStr(mock as unknown as CDP, "shared-session", { url: "https://two.test" });
    await Promise.resolve(); await Promise.resolve();
    expect(mock.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1);
    mock.loadResolvers.shift()?.();
    await first;
    await Promise.resolve(); await Promise.resolve();
    expect(mock.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(2);
    mock.loadResolvers.shift()?.();
    await second;
  });
});
