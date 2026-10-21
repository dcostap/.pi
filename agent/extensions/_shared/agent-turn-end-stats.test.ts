import assert from "node:assert/strict";
import { mock, test } from "bun:test";

// These tests use plain text. Pi supplies ANSI-aware width helpers at runtime.
mock.module("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
}));
const { default: registerStats } = await import("../agent-turn-end-stats.ts");

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: string[] = [];
  const renderers = new Map<string, any>();
  const settings: { outputPad?: 0 | 1 } = {};
  let runtimeActive = true;
  registerStats({
    getSettings() {
      if (!runtimeActive) throw new Error("Extension runtime is stale after reload");
      return settings;
    },
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    registerEntryRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
  } as any);
  const state = {
    now: 1_000,
    entries,
    notifications,
    settings,
    invalidateRuntime() {
      runtimeActive = false;
    },
    component(data = entries.at(-1)?.data, theme = {
      fg: (_color: string, text: string) => text,
      italic: (text: string) => text,
    }) {
      return renderers.get("turn-stats")({ data }, { expanded: false }, theme);
    },
    render(data = entries.at(-1)?.data, width = 200): string {
      return state.component(data).render(width).join("\n");
    },
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
      await state.emit("session_start");
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
  assert.match(state.render(), /154 tok\/s/);
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
  assert.doesNotMatch(state.render(), /tok\/s/);
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
    assert.match(state.render(), /~2 tok\/s/);
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

scenario("rounds displayed durations to whole seconds with correct minute rollover", async (state) => {
  state.now += 1_000;
  const stats = await state.finish([]);
  for (const [ms, expected] of [
    [0, "0s"],
    [499, "0s"],
    [500, "1s"],
    [1_499, "1s"],
    [1_500, "2s"],
    [59_499, "59s"],
    [59_500, "1m 0s"],
    [119_500, "2m 0s"],
  ] as const) {
    const line = state.render({ ...stats, totalMs: ms, toolMs: ms, avgLatencyMs: ms });
    assert.ok(line.includes(`${expected} total · ${expected} tools`));
    if (ms > 0) assert.ok(line.includes(`${expected} avg latency`));
  }
});

scenario("stores one transcript entry without a replaceable notification", async (state) => {
  const message = assistant(state.now, 100);
  state.now += 1_000;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  const line = state.render();
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.notifications, []);
  assert.match(line, /1s total · 0s tools · ↑100 ↓100 · 100 tok\/s/);

  // Later runs and compaction notices must not change the saved line.
  state.now += 60_000;
  await state.emit("agent_start");
  await state.emit("session_before_compact");
  await state.emit("session_compact");
  await state.emit("session_shutdown");
  assert.equal(state.render(stats), line);
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.notifications, []);
});

scenario("renders saved entries in a fresh extension without adding entries", async (state) => {
  const message = assistant(state.now, 100);
  state.now += 1_000;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  const saved = JSON.parse(JSON.stringify(stats));
  const restored = setup();
  await restored.emit("session_start");
  assert.equal(restored.render(saved), state.render(stats));
  assert.deepEqual(restored.entries, []);
  assert.deepEqual(restored.notifications, []);

  // Older entries do not have request timing fields.
  delete saved.requestMs;
  delete saved.rateBasis;
  assert.equal(restored.render(saved), state.render(stats));
});

scenario("adapts saved statistics to the component width on each render", async (state) => {
  const message = assistant(state.now, 100);
  state.now += 1_000;
  await state.emit("message_end", { message });
  const stats = await state.finish([message]);
  const component = state.component(stats);
  const wide = component.render(200);
  assert.match(wide[0], /tools/);
  for (const width of [0, 1, 5, 10, 20, 40, 80]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length <= width);
  }
  assert.deepEqual(component.render(200), wide);
});

scenario("reads Pi's outputPad setting at session and agent startup", async (state) => {
  state.now += 1_000;
  const stats = await state.finish([]);
  const component = state.component(stats);
  const defaultLine = component.render(200)[0];
  assert.match(defaultLine, /^ 1s total/);

  state.settings.outputPad = 0;
  await state.emit("session_start");
  assert.match(component.render(200)[0], /^1s total/);
  state.settings.outputPad = 1;
  await state.emit("agent_start");
  assert.equal(component.render(200)[0], defaultLine);

  for (const padding of [0, 1] as const) {
    state.settings.outputPad = padding;
    await state.emit("agent_start");
    for (const width of [0, 1, 2, 5, 10, 20, 40]) {
      assert.ok(component.render(width)[0].length <= width);
    }
  }
});

scenario("uses the saved finish time and the active theme", async (state) => {
  state.now += 1_000;
  const stats = await state.finish([]);
  // Use a distinct historical time, not the current clock.
  stats.timestamp = new Date(2020, 0, 1, 13, 15).getTime();
  const colors: string[] = [];
  const italicText: string[] = [];
  const component = state.component(stats, {
    fg(color: string, text: string) {
      colors.push(color);
      return text;
    },
    italic(text: string) {
      italicText.push(text);
      return text;
    },
  });
  assert.match(component.render(200)[0], /13:15/);
  component.invalidate();
  component.render(200);
  assert.deepEqual(colors, ["dim", "dim"]);
  assert.equal(italicText.length, 2);
  assert.match(italicText[0], /1s total.*13:15/);
  assert.equal(italicText[1], italicText[0]);
});

test("does not render entries without data", () => {
  assert.equal(setup().component(), undefined);
});

scenario("renders old transcript components after reload retires their extension API", async (state) => {
  state.settings.outputPad = 0;
  await state.emit("session_start");
  state.now += 1_000;
  const stats = await state.finish([]);
  const component = state.component(stats);
  const lines = component.render(200);
  await state.emit("session_shutdown");
  state.invalidateRuntime();

  assert.deepEqual(component.render(200), lines);
  component.invalidate();
  assert.deepEqual(component.render(200), lines);
  assert.deepEqual(state.component(stats).render(200), lines);
  assert.ok(component.render(10)[0].length <= 10);
});
