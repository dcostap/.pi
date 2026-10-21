import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, mock, test } from "bun:test";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-compact-with-model-"));
const previousLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = temporaryDirectory;
const configPath = join(temporaryDirectory, "pi", "compaction-model.json");
const calls: any[][] = [];
let generationError: Error | undefined;
let generate: ((args: any[]) => void) | undefined;
const result = {
	summary: "Summary",
	firstKeptEntryId: "kept",
	tokensBefore: 25_000,
	usage: { input: 100, output: 20 },
	details: { readFiles: [], modifiedFiles: [] },
};

mock.module("@earendil-works/pi-coding-agent", () => ({
	compact: async (...args: any[]) => {
		calls.push(args);
		generate?.(args);
		if (generationError) throw generationError;
		return result;
	},
	convertToLlm: (messages: any[]) => messages,
	serializeConversation: (messages: any[]) => JSON.stringify(messages),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class {},
	Input: class {},
	Spacer: class {},
	Text: class {},
	fuzzyFilter: (items: any[]) => items,
	matchesKey: () => false,
}));
mock.module("@earendil-works/pi-ai/compat", () => ({
	clampThinkingLevel: (model: any, level: string) => model.reasoning ? level : "off",
}));
const { default: register } = await import("../compaction-model.ts");
if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
else process.env.LOCALAPPDATA = previousLocalAppData;
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function model(id: string, extra = {}) {
	return { provider: "test", id, name: id, contextWindow: 200_000, maxTokens: 16_000, reasoning: true, ...extra };
}

function setup() {
	rmSync(configPath, { force: true });
	calls.length = 0;
	generationError = undefined;
	generate = undefined;
	const chat = model("chat");
	const chosen = model("chosen");
	const global = model("global");
	const commands = new Map<string, any>();
	const events = new Map<string, any[]>();
	const notices: string[] = [];
	const defaultCalls: any[] = [];
	const settings: any = { defaultThinkingLevel: "high", modelThinkingLevels: { "test/chosen": "low" } };
	const state = {
		chat, chosen, global, notices, defaultCalls, settings,
		selection: "test/chosen" as string | undefined,
		idle: true,
		auth: { ok: true, apiKey: "chosen-key", headers: { test: "header" }, env: { TEST: "value" } } as any,
		authError: undefined as Error | undefined,
		preparationError: undefined as Error | undefined,
		beforeCompact: undefined as (() => Promise<void>) | undefined,
		select: undefined as (() => Promise<string | undefined>) | undefined,
		pickerOptions: [] as string[],
		compactCount: 0,
		find: (provider: string, id: string) => [chat, chosen, global].find((item) => item.provider === provider && item.id === id),
		async emit(name: string, event: any) {
			let response;
			for (const handler of events.get(name) ?? []) {
				const next = await handler(event, ctx);
				if (next) response = next;
				if (response?.cancel) break;
			}
			return response;
		},
		event(reason = "manual") {
			return {
				reason,
				signal: new AbortController().signal,
				customInstructions: "Keep decisions",
				preparation: {
					messagesToSummarize: [{ role: "user", content: "History" }],
					turnPrefixMessages: [],
					settings: { reserveTokens: 16_384 },
				},
			};
		},
		async command(name = "compact-with-model", args = "") {
			await commands.get(name).handler(args, ctx);
		},
		setGlobal() {
			mkdirSync(join(temporaryDirectory, "pi"), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ provider: global.provider, model: global.id }));
		},
	};
	const ctx: any = {
		mode: "rpc", hasUI: true, model: chat, thinkingLevel: "max",
		scopedModels: [{ model: chosen }, { model: chat }],
		isIdle: () => state.idle,
		modelRegistry: {
			streamSimple: () => ({ push: () => {} }),
			getAvailable: () => [chat, chosen, global],
			find: (provider: string, id: string) => state.find(provider, id),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => {
				if (state.authError) throw state.authError;
				return state.auth;
			},
		},
		ui: {
			setWidget: () => assert.fail("Must not add a compaction widget"),
			setStatus: () => assert.fail("Must not add footer status"),
			notify: (text: string) => notices.push(text),
			select: async (_title: string, options: string[]) => {
				state.pickerOptions = options;
				return state.select ? state.select() : state.selection;
			},
		},
		compact: (options: any) => {
			state.compactCount++;
			void (async () => {
				try {
					if (state.preparationError) throw state.preparationError;
					await state.beforeCompact?.();
					const event = state.event();
					event.customInstructions = options.customInstructions;
					const response = await state.emit("session_before_compact", event);
					if (response?.cancel) throw new Error("Compaction cancelled");
					if (!response?.compaction) defaultCalls.push(chat);
					await state.emit("session_compact", {});
					options.onComplete(response?.compaction ?? result);
				} catch (error) {
					await state.emit("session_compact_failed", {});
					options.onError(error);
				}
			})();
		},
	};
	const pi: any = {
		on: (name: string, handler: any) => events.set(name, [...(events.get(name) ?? []), handler]),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		getSettings: () => settings,
		setModel: () => assert.fail("Must not change the chat model"),
		setThinkingLevel: () => assert.fail("Must not change chat thinking"),
	};
	register(pi);
	return { state, ctx };
}

test("uses the scoped picker and selected model for exactly one compaction", async () => {
	const { state, ctx } = setup();
	const settingsBefore = JSON.stringify(state.settings);
	await state.command("compact-with-model", " Keep decisions ");
	assert.deepEqual(state.pickerOptions, ["test/chosen", "test/chat"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1], state.chosen);
	assert.equal(calls[0][2], "chosen-key");
	assert.equal(calls[0][3].test, "header");
	assert.equal(calls[0][4], "Keep decisions");
	assert.equal(calls[0][6], "low");
	assert.equal(calls[0][8].TEST, "value");
	assert.equal(ctx.model, state.chat);
	assert.equal(ctx.thinkingLevel, "max");
	assert.equal(JSON.stringify(state.settings), settingsBefore);
	assert.deepEqual(state.defaultCalls, []);
	assert.equal(await state.emit("session_before_compact", state.event()), undefined);
	assert.equal(calls.length, 1);
});

test("overrides the global compaction model without saving the selection", async () => {
	const { state } = setup();
	state.setGlobal();
	const before = readFileSync(configPath, "utf8");
	await state.command();
	assert.equal(calls[0][1], state.chosen);
	assert.equal(readFileSync(configPath, "utf8"), before);
	const response = await state.emit("session_before_compact", state.event());
	assert.equal(response.compaction, result);
	assert.equal(calls[1][1], state.global);
	assert.equal(calls[1][6], "off");
});

test("does not read the global config for a one-time selection", async () => {
	const { state } = setup();
	state.setGlobal();
	writeFileSync(configPath, "invalid json");
	await state.command();
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1], state.chosen);
	assert.deepEqual(state.defaultCalls, []);
});

test("uses available models when no scope exists", async () => {
	const { state, ctx } = setup();
	ctx.scopedModels = [];
	await state.command();
	assert.deepEqual(state.pickerOptions, ["test/chat", "test/chosen", "test/global"]);
});

test("cancel closes the picker without compaction", async () => {
	const { state } = setup();
	state.selection = undefined;
	await state.command();
	assert.equal(state.compactCount, 0);
	state.selection = "test/chosen";
	await state.command();
	assert.equal(calls.length, 1);
});

test("uses scoped thinking before model and startup defaults", async () => {
	const { state, ctx } = setup();
	ctx.scopedModels[0].thinkingLevel = "medium";
	await state.command();
	assert.equal(calls[0][6], "medium");
	delete ctx.scopedModels[0].thinkingLevel;
	delete state.settings.modelThinkingLevels["test/chosen"];
	await state.command();
	assert.equal(calls[1][6], "high");
	delete state.settings.defaultThinkingLevel;
	await state.command();
	assert.equal(calls[2][6], "medium");
});

test("clamps thinking for a model without reasoning", async () => {
	const { state } = setup();
	state.chosen.reasoning = false;
	await state.command();
	assert.equal(calls[0][6], "off");
});

for (const failure of ["missing model", "missing auth", "auth error", "context too small", "generation error", "abort"]) {
	test(`${failure} cancels without using the chat or global model`, async () => {
		const { state } = setup();
		state.setGlobal();
		if (failure === "missing model") state.find = () => undefined;
		if (failure === "missing auth") state.auth = { ok: false, error: "No key" };
		if (failure === "auth error") state.authError = new Error("Auth failed");
		if (failure === "context too small") state.chosen.contextWindow = 100;
		if (failure === "generation error") generationError = new Error("Provider failed");
		if (failure === "abort") {
			generationError = new Error("Aborted");
			const original = state.event;
			state.event = (reason) => {
				const event = original(reason);
				event.signal = AbortSignal.abort();
				return event;
			};
		}
		await state.command();
		assert.deepEqual(state.defaultCalls, []);
		assert.ok(calls.every((args) => args[1] === state.chosen));
		assert.ok(state.notices.some((notice) => notice.includes("failed:")));
		assert.ok(!state.notices.some((notice) => notice.includes("Continuing with Pi's default")));
		// No stale one-time selection survives failure.
		generationError = undefined;
		rmSync(configPath);
		assert.equal(await state.emit("session_before_compact", state.event()), undefined);
	});
}

test("clears the selection when compaction fails before the hook", async () => {
	const { state } = setup();
	state.preparationError = new Error("Nothing to compact");
	await state.command();
	assert.equal(calls.length, 0);
	assert.equal(await state.emit("session_before_compact", state.event()), undefined);
	state.preparationError = undefined;
	await state.command();
	assert.equal(calls.length, 1);
});

test("automatic compaction does not use a pending one-time selection", async () => {
	const { state } = setup();
	state.setGlobal();
	state.beforeCompact = async () => {
		await state.emit("session_before_compact", state.event("threshold"));
	};
	await state.command();
	assert.equal(calls[0][1], state.global);
	assert.equal(calls[1][1], state.chosen);
});

test("preserves normal global fallback after a one-time selection", async () => {
	const { state } = setup();
	state.setGlobal();
	await state.command();
	generationError = new Error("Global provider failed");
	assert.equal(await state.emit("session_before_compact", state.event()), undefined);
	assert.equal(calls[1][1], state.global);
	assert.ok(state.notices.some((notice) => notice.includes("Continuing with Pi's default compaction")));
});

test("rejects busy sessions before and after the picker", async () => {
	const { state } = setup();
	state.idle = false;
	await state.command();
	assert.equal(state.pickerOptions.length, 0);
	state.idle = true;
	state.select = async () => { state.idle = false; return "test/chosen"; };
	await state.command();
	assert.equal(state.compactCount, 0);
});

test("rejects duplicate commands while a picker is open", async () => {
	const { state } = setup();
	let close!: (selection: string | undefined) => void;
	state.select = () => new Promise((resolve) => { close = resolve; });
	const first = state.command();
	await state.command();
	assert.ok(state.notices.some((notice) => notice.includes("Wait for the current operation")));
	close(undefined);
	await first;
	assert.equal(state.compactCount, 0);
});

test("handles unavailable UI and empty model lists", async () => {
	const { state, ctx } = setup();
	ctx.hasUI = false;
	await state.command();
	assert.equal(state.pickerOptions.length, 0);
	ctx.hasUI = true;
	ctx.scopedModels = [];
	ctx.modelRegistry.getAvailable = () => [];
	await state.command();
	assert.equal(state.compactCount, 0);
	assert.ok(state.notices.some((notice) => notice.includes("No models are available")));
});

test("manual compaction remains available when autocompact is off", async () => {
	const { state } = setup();
	await state.command("autocompact", "off");
	await state.command();
	assert.equal(calls.length, 1);
	assert.deepEqual(await state.emit("session_before_compact", state.event("threshold")), { cancel: true });
});

test("adds no widget or footer status during compaction", async () => {
	const { state, ctx } = setup();
	ctx.mode = "tui";
	await state.command();
	assert.equal(calls.length, 1);
	state.setGlobal();
	await state.emit("session_before_compact", state.event("threshold"));
	assert.equal(calls[1][1], state.global);
});

test("does not wrap or inspect the provider stream", async () => {
	const { state, ctx } = setup();
	const stream = { push: () => {} };
	const context = {};
	const options = {};
	ctx.modelRegistry.streamSimple = function (model: any, actualContext: any, actualOptions: any) {
		assert.equal(this, ctx.modelRegistry);
		assert.equal(model, state.chosen);
		assert.equal(actualContext, context);
		assert.equal(actualOptions, options);
		return stream;
	};
	generate = (args) => assert.equal(args[7](state.chosen, context, options), stream);
	await state.command();
});
