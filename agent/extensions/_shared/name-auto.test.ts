import assert from "node:assert/strict";
import { mock, test } from "bun:test";

let provider = "claude-bridge";
const signal = new AbortController().signal;

mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => ".",
	BorderedLoader: class { signal = signal; },
	convertToLlm: (messages: unknown[]) => messages,
	serializeConversation: (messages: unknown[]) => JSON.stringify(messages),
}));
const { getModelRoleRequestOptions } = await import("./model-roles");
mock.module("./model-roles", () => ({
	FAST_CHEAP_ROLE: "fastCheap",
	resolveModelRole: async () => ({
		ok: true,
		config: {},
		model: { provider, id: "test-model", contextWindow: 200_000 },
		auth: { apiKey: "test-key", headers: { test: "header" } },
		label: `${provider}/test-model`,
	}),
	getModelRoleRequestOptions,
}));

const { default: register, buildNamingContext, parseSuggestion } = await import("../name-auto.ts");

for (const selectedProvider of ["claude-bridge", "anthropic", "openai-codex"]) {
	test(`shared fast-model options for ${selectedProvider}`, () => {
		const resolved: any = {
			model: { provider: selectedProvider, reasoning: true },
			config: { maxTokens: 4096, reasoningEffort: "low" },
		};
		const expected = {
			maxTokens: 4096,
			reasoningEffort: "low",
			...(selectedProvider === "claude-bridge" ? { cacheRetention: "none" } : {}),
		};
		// Web processing uses no cap; naming and TL;DR supply a cap.
		assert.deepEqual(getModelRoleRequestOptions(resolved), expected);
		assert.deepEqual(getModelRoleRequestOptions(resolved, { maxTokensCap: 2048 }), { ...expected, maxTokens: 2048 });
		assert.deepEqual(getModelRoleRequestOptions({ ...resolved, config: {} }),
			selectedProvider === "claude-bridge" ? { cacheRetention: "none" } : {});
	});

	test(`name_auto sets the name for ${selectedProvider}`, async () => {
		provider = selectedProvider;
		const h = harness({ replies: ['{"name": "Bridge naming request fix", "needsRefinement": false}'] });
		await h.command("");
		assert.deepEqual(h.errors, []);
		assert.equal(h.name, "Bridge naming request fix");
		assert.equal(h.requests[0].model.provider, selectedProvider);
		assert.equal(h.requests[0].context.messages.length, 1);
		assert.deepEqual(h.requests[0].options, {
			apiKey: "test-key",
			headers: { test: "header" },
			maxTokens: 80,
			...(selectedProvider === "claude-bridge" ? { cacheRetention: "none" } : {}),
			signal,
			sessionId: "test-session",
		});
	});
}

function harness({ name, replies }: { name?: string; replies: string[] }) {
	const handlers = new Map<string, any>();
	let command: any;
	const entries: any[] = [
		{ type: "message", message: { role: "user", content: "Fix naming requests" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Done." }] } },
	];
	const state = {
		name,
		entries,
		requests: [] as any[],
		errors: [] as string[],
		async settle() {
			handlers.get("agent_settled")({ aborted: false }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		command: (args: string) => command(args, ctx),
	};
	const ctx = {
		waitForIdle: async () => {},
		hasUI: true,
		sessionManager: { getSessionId: () => "test-session", getBranch: () => entries, getEntries: () => entries },
		modelRegistry: {
			complete: async (model: any, context: any, options: any) => {
				state.requests.push({ model, context, options });
				return { stopReason: "stop", content: [{ type: "text", text: replies[state.requests.length - 1] ?? replies.at(-1) }] };
			},
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			custom: (factory: any) => new Promise((done) => factory({}, {}, {}, done)),
			notify: (message: string, level: string) => { if (level !== "info") state.errors.push(message); },
		},
	};
	register({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (_name: string, options: any) => { command = options.handler; },
		getSessionName: () => state.name,
		setSessionName: (next: string) => { state.name = next; },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
	} as any);
	return state;
}

test("auto-names an unnamed session once", async () => {
	const h = harness({ replies: ['```json\n{"name": "Session auto-naming", "needsRefinement": false}\n```'] });
	await h.settle();
	await h.settle();
	assert.equal(h.name, "Session auto-naming");
	assert.equal(h.requests.length, 1);
	assert.doesNotMatch(h.requests[0].context.messages[0].content[0].text, /Current name/);
});

test("refines a vague name until the try limit", async () => {
	const h = harness({ replies: ['{"name": "Unclear request", "needsRefinement": true}'] });
	for (let i = 0; i < 7; i++) await h.settle();
	assert.equal(h.requests.length, 5);
	const retry = h.requests[1].context.messages[0].content[0].text;
	assert.match(retry, /current name "Unclear request" is temporary/);
	assert.doesNotMatch(retry, /Keep it unchanged/);
});

test("stops refining when the model is sure", async () => {
	const h = harness({ replies: ['{"name": "Unclear request", "needsRefinement": true}', '{"name": "Login bug fix", "needsRefinement": false}'] });
	for (let i = 0; i < 4; i++) await h.settle();
	assert.equal(h.name, "Login bug fix");
	assert.equal(h.requests.length, 2);
});

test("a user-set name stops refinement", async () => {
	const h = harness({ replies: ['{"name": "Unclear request", "needsRefinement": true}'] });
	await h.settle();
	h.name = "My own name";
	await h.settle();
	assert.equal(h.requests.length, 1);
	assert.equal(h.name, "My own name");
});

test("name_auto asks to keep a name that is not temporary", async () => {
	const h = harness({ name: "My own name", replies: ['{"name": "My own name", "needsRefinement": false}'] });
	await h.command("");
	assert.match(h.requests[0].context.messages[0].content[0].text, /Current name: "My own name". Keep it unchanged/);
	assert.equal(h.name, "My own name");
});

test("does not rename a named session such as a subagent", async () => {
	const h = harness({ name: "[Subagent 3] Review parser", replies: ['{"name": "Other", "needsRefinement": false}'] });
	await h.settle();
	assert.equal(h.requests.length, 0);
});

test("parses names leniently", () => {
	assert.deepEqual(parseSuggestion('{"name": "\\"Fix login.\\"", "needsRefinement": true}'), { name: "Fix login", needsRefinement: true });
	assert.deepEqual(parseSuggestion("Name: Fix login"), { name: "Fix login", needsRefinement: false });
	assert.deepEqual(parseSuggestion("{not json}"), { name: "{not json}", needsRefinement: false });
});

test("naming context keeps the first and newest messages within budget", () => {
	const sections = [
		{ role: "user" as const, text: "FIRST " + "a".repeat(3_000) },
		...Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `msg${i} ` + "b".repeat(1_000) })),
	];
	const context = buildNamingContext(sections);
	assert.ok(context.length <= 8_100);
	assert.match(context, /^\[Some content omitted\]/);
	assert.match(context, /USER:\nFIRST/);
	assert.match(context, /msg18/);
	assert.match(context, /msg19/);
	assert.doesNotMatch(context, /msg0 /);
});
