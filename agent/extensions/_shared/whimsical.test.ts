import assert from "node:assert/strict";
import { test } from "bun:test";
import registerWhimsical from "../whimsical.ts";

function scenario(name: string, run: (state: ReturnType<typeof setup>) => void) {
  test(name, () => {
    const originalNow = Date.now;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const state = setup();
    Date.now = () => state.now;
    globalThis.setInterval = ((callback: () => void) => {
      const handle = { unref() {} };
      state.timers.set(handle, callback);
      return handle;
    }) as any;
    globalThis.clearInterval = ((handle: any) => state.timers.delete(handle)) as any;
    try {
      run(state);
    } finally {
      Date.now = originalNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
}

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const messages: Array<string | undefined> = [];
  registerWhimsical({
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
  } as any);
  const state = {
    now: 1000,
    mode: "tui",
    timers: new Map<object, () => void>(),
    messages,
    emit(name: string, event: any = {}) {
      handlers.get(name)?.(event, {
        mode: state.mode,
        ui: { setWorkingMessage: (message?: string) => messages.push(message) },
      });
    },
    tick(elapsedMs: number) {
      state.now += elapsedMs;
      for (const callback of state.timers.values()) callback();
    },
  };
  return state;
}

scenario("shows seconds only after three seconds and updates once per second", (state) => {
  state.emit("turn_start");
  const message = state.messages[0];
  state.tick(3000);
  assert.deepEqual(state.messages, [message]);
  state.tick(250);
  assert.equal(state.messages.at(-1), `${message} (3s)`);
  state.tick(250);
  assert.equal(state.messages.length, 2);
  state.tick(500);
  assert.equal(state.messages.at(-1), `${message} (4s)`);
});

for (const update of [
  { type: "text_delta", delta: "Hello" },
  { type: "thinking_delta", delta: "Let me think" },
  { type: "toolcall_delta", delta: "{" },
  { type: "toolcall_start" },
]) {
  scenario(`stops waiting on ${update.type}, not stream metadata`, (state) => {
    state.emit("turn_start");
    const message = state.messages[0];
    state.emit("message_start", { message: { role: "assistant" } });
    state.emit("message_update", { assistantMessageEvent: { type: "start" } });
    state.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
    state.tick(5000);
    assert.equal(state.messages.at(-1), `${message} (5s)`);
    state.emit("message_update", { assistantMessageEvent: update });
    assert.equal(state.messages.at(-1), message);
    assert.equal(state.timers.size, 0);
    state.tick(10_000);
    assert.equal(state.messages.at(-1), message);
  });
}

scenario("resets each turn and excludes tool execution time", (state) => {
  state.emit("turn_start");
  state.tick(5000);
  state.emit("message_end", { message: { role: "assistant" } });
  assert.equal(state.timers.size, 0);
  state.emit("tool_execution_start");
  state.tick(20_000);
  state.emit("tool_execution_end");
  state.emit("turn_end");
  assert.equal(state.messages.at(-1), undefined);
  state.emit("turn_start");
  const message = state.messages.at(-1);
  state.tick(3000);
  assert.equal(state.messages.at(-1), message);
  state.tick(1000);
  assert.equal(state.messages.at(-1), `${message} (4s)`);
});

for (const event of ["turn_end", "agent_end", "session_shutdown"]) {
  scenario(`clears the timer on ${event}`, (state) => {
    state.emit("turn_start");
    state.tick(5000);
    state.emit(event);
    assert.equal(state.timers.size, 0);
    const count = state.messages.length;
    state.tick(10_000);
    assert.equal(state.messages.length, count);
  });
}

scenario("replaces the timer if another turn starts", (state) => {
  state.emit("turn_start");
  state.tick(5000);
  state.emit("turn_start");
  assert.equal(state.timers.size, 1);
  const message = state.messages.at(-1);
  state.tick(3000);
  assert.equal(state.messages.at(-1), message);
});

scenario("does not start timers outside the terminal UI", (state) => {
  for (const mode of ["rpc", "json", "print"]) {
    state.mode = mode;
    state.emit("turn_start");
    assert.equal(state.timers.size, 0);
    assert.equal(state.messages.length, 0);
  }
});
