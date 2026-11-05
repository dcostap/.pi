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

const { default: register } = await import("../name-auto.ts");

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

	test(`name_auto request options for ${selectedProvider}`, async () => {
		provider = selectedProvider;
		let handler: any;
		let request: any;
		let editorText: string | undefined;
		const errors: string[] = [];
		register({
			registerCommand(name: string, command: any) {
				assert.equal(name, "name_auto");
				handler = command.handler;
			},
		} as any);
		await handler("", {
			waitForIdle: async () => {},
			hasUI: true,
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [{ type: "message", message: { role: "user", content: "Fix naming requests" } }],
			},
			modelRegistry: {
				complete: async (model: any, context: any, options: any) => {
					request = { model, context, options };
					return { stopReason: "stop", content: [{ type: "text", text: "Bridge naming request fix" }] };
				},
			},
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: () => {},
				custom: (factory: any) => new Promise((done) => factory({}, {}, {}, done)),
				setEditorText: (text: string) => { editorText = text; },
				notify: (message: string, level: string) => { if (level === "error") errors.push(message); },
			},
		});
		assert.deepEqual(errors, []);
		assert.equal(editorText, "/name Bridge naming request fix");
		assert.equal(request.model.provider, selectedProvider);
		assert.equal(request.context.systemPrompt.length, 318);
		assert.equal(request.context.messages.length, 1);
		assert.deepEqual(request.options, {
			apiKey: "test-key",
			headers: { test: "header" },
			maxTokens: 40,
			...(selectedProvider === "claude-bridge" ? { cacheRetention: "none" } : {}),
			signal,
			sessionId: "test-session",
		});
	});
}
