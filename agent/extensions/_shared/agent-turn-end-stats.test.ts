import assert from "node:assert/strict";
import { mock, test } from "bun:test";

// These tests use plain text. Keep terminal rendering outside the timing tests.
mock.module("@earendil-works/pi-tui", () => ({ visibleWidth: (text: string) => text.length }));
const { default: registerStats } = await import("../agent-turn-end-stats.ts");

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: string[] = [];
  registerStats({
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
  } as any);
  const state = {
    now: 1_000,
    entries,
    notifications,
    async emit(name: string, event: any = {}) {
      await handlers.get(name)?.(event, { ui: { notify: (text: string) => notifications.push(text) } });
    },
    async finish(messages: any[]) {
      await state.emit("agent_end", { messages });
      assert.equal(entries.at(-1)?.type, "turn-stats");
      return entries.at(-1)!.data;
    },
  };
  return state;
}

function scenario(name: string, run: (state: ReturnType<typeof setup>) => Promise<void>) {
  test(name, async () => {
    const originalNow = Date.now;
    const state = setup();
    Date.now = () => state.now;
    try {
      await state.emit("agent_start");
      await run(state);
    } finally {
      Date.now = originalNow;
    }
  });
}

function assistant(timestamp: number, output: number | undefined, content: any[] = []) {
  return {
    role: "assistant",
    timestamp,
    content,
    ...(output === undefined ? {} : { usage: { input: 100, output, cacheRead: 200, cacheWrite: 300 } }),
  };
}

scenario("includes hidden reasoning and the wait before a buffered first chunk", async (state) => {
  const message = assistant(state.now, 10_000, [{ type: "text", text: "Result" }]);
  await state.emit("before_provider_request");
  state.now = 61_000;
  await state.emit("message_start", { message });
  await state.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Result" } });
  state.now = 66_000;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  assert.equal(stats.requestMs, 65_000);
  assert.equal(stats.tokensPerSecond, 10_000 / 65);
  assert.equal(stats.rateBasis, "full-request");
  assert.equal(stats.estimatedTokens, false);
  assert.match(state.notifications.at(-1)!, /153\.8 tok\/s/);
});

scenario("includes tool-call-only requests and excludes parallel tool execution", async (state) => {
  const first = assistant(state.now, 500, [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]);
  state.now = 6_000;
  await state.emit("message_end", { message: first });
  state.now = 6_100;
  await state.emit("tool_execution_start", { toolCallId: "a" });
  state.now = 10_000;
  await state.emit("tool_execution_start", { toolCallId: "b" });
  state.now = 20_000;
  await state.emit("tool_execution_end", { toolCallId: "a" });
  state.now = 26_100;
  await state.emit("tool_execution_end", { toolCallId: "b" });
  state.now = 27_000;
  const second = assistant(state.now, 500);
  state.now = 32_000;
  await state.emit("message_end", { message: second });
  const stats = await state.finish([first, { role: "toolResult" }, second]);
  assert.equal(stats.requestMs, 10_000);
  assert.equal(stats.toolMs, 20_000);
  assert.equal(stats.totalMs, 31_000);
  assert.equal(stats.outputTokens, 1_000);
  assert.equal(stats.tokensPerSecond, 100);
});

scenario("divides summed tokens by summed request time, not the mean of request rates", async (state) => {
  const first = assistant(state.now, 10);
  state.now += 1_000;
  await state.emit("message_end", { message: first });
  const second = assistant(state.now, 900);
  state.now += 9_000;
  await state.emit("message_end", { message: second });
  const stats = await state.finish([first, second]);
  assert.equal(stats.tokensPerSecond, 91);
  assert.equal(stats.inputTokens, 200);
  assert.equal(stats.cacheReadTokens, 400);
  assert.equal(stats.cacheWriteTokens, 600);
});

scenario("does not show a rate for a request shorter than 100 ms", async (state) => {
  const message = assistant(state.now, 10_000);
  state.now += 1;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  assert.equal(stats.tokensPerSecond, null);
  assert.equal(stats.outputTokens, 10_000);
  assert.doesNotMatch(state.notifications.at(-1)!, /tok\/s/);
});

scenario("shows a rate at the 100 ms boundary", async (state) => {
  const message = assistant(state.now, 10);
  state.now += 100;
  await state.emit("message_end", { message });
  assert.equal((await state.finish([message])).tokensPerSecond, 100);
});

scenario("does not invent a duration when a message-end event is missing", async (state) => {
  const first = assistant(state.now, 100);
  state.now += 1_000;
  await state.emit("message_end", { message: first });
  const second = assistant(state.now, 100);
  state.now += 1_000;
  const stats = await state.finish([first, second]);
  assert.equal(stats.outputTokens, 200);
  assert.equal(stats.tokensPerSecond, null);
});

scenario("rejects missing, stale, future, and non-finite request timestamps", async (state) => {
  for (const timestamp of [undefined, 0, 20_000, NaN, Infinity]) {
    await state.emit("agent_start");
    const message = { ...assistant(state.now, 100), timestamp };
    state.now += 1_000;
    await state.emit("message_end", { message });
    assert.equal((await state.finish([message])).tokensPerSecond, null);
  }
});

scenario("respects a provider-reported zero instead of estimating visible content", async (state) => {
  const message = assistant(state.now, 0, [{ type: "text", text: "Cached or aborted output" }]);
  state.now += 1_000;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  assert.equal(stats.outputTokens, 0);
  assert.equal(stats.estimatedTokens, false);
  assert.equal(stats.tokensPerSecond, null);
});

scenario("estimates final content once, independent of streamed chunk sizes", async (state) => {
  for (const chunks of [["abcdefgh"], ["a", "b", "c", "d", "e", "f", "g", "h"]]) {
    await state.emit("agent_start");
    const message = assistant(state.now, undefined, [{ type: "text", text: chunks.join("") }]);
    for (const delta of chunks) {
      state.now += 1;
      await state.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta } });
    }
    state.now = message.timestamp + 1_000;
    await state.emit("message_end", { message });
    const stats = await state.finish([message]);
    assert.equal(stats.outputTokens, 2);
    assert.equal(stats.estimatedTokens, true);
    assert.equal(stats.tokensPerSecond, 2);
    assert.match(state.notifications.at(-1)!, /~2\.0 tok\/s/);
  }
});

scenario("keeps exact usage while estimating missing usage in another message", async (state) => {
  const first = assistant(state.now, 100);
  state.now += 1_000;
  await state.emit("message_end", { message: first });
  const second = assistant(state.now, undefined, [
    { type: "thinking", thinking: "abcdefgh" },
    { type: "toolCall", name: "bash", arguments: {} },
  ]);
  state.now += 1_000;
  await state.emit("message_end", { message: second });
  const stats = await state.finish([first, second]);
  assert.equal(stats.outputTokens, 104);
  assert.equal(stats.estimatedTokens, true);
  assert.equal(stats.tokensPerSecond, 52);
});

scenario("uses a marked estimate for invalid output counts", async (state) => {
  for (const output of [NaN, Infinity, -10]) {
    await state.emit("agent_start");
    const message = assistant(state.now, output, [{ type: "text", text: "abcdefgh" }]);
    state.now += 1_000;
    await state.emit("message_end", { message });
    const stats = await state.finish([message]);
    assert.equal(stats.outputTokens, 2);
    assert.equal(stats.estimatedTokens, true);
    assert.equal(stats.tokensPerSecond, 2);
  }
});

scenario("keeps the full logical request span when provider attempts repeat", async (state) => {
  const message = assistant(state.now, 100);
  await state.emit("before_provider_request");
  state.now += 2_000;
  await state.emit("before_provider_request");
  state.now += 3_000;
  await state.emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  assert.equal(stats.requestMs, 5_000);
  assert.equal(stats.tokensPerSecond, 20);
  assert.deepEqual(stats.latenciesMs, [3_000]);
});

scenario("resets request timing and usage for the next agent run", async (state) => {
  const first = assistant(state.now, 500);
  state.now += 5_000;
  await state.emit("message_end", { message: first });
  await state.finish([first]);
  state.now += 100_000;
  await state.emit("agent_start");
  const second = assistant(state.now, 10);
  state.now += 1_000;
  await state.emit("message_end", { message: second });
  const stats = await state.finish([second]);
  assert.equal(stats.totalMs, 1_000);
  assert.equal(stats.requestMs, 1_000);
  assert.equal(stats.outputTokens, 10);
  assert.equal(stats.tokensPerSecond, 10);
});

scenario("does not show a rate for an empty run", async (state) => {
  state.now += 1_000;
  const stats = await state.finish([]);
  assert.equal(stats.requestMs, 0);
  assert.equal(stats.outputTokens, 0);
  assert.equal(stats.tokensPerSecond, null);
});
