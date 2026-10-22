import assert from "node:assert/strict";
import test from "node:test";
import {
	extractCitationSources,
	formatSearchOutput,
	registerCitationHandling,
	replaceCitations,
} from "./citations.ts";

const url = "https://code.claude.com/docs/en/worktrees";
const header = `Run parallel sessions with worktrees - Claude Code Docs (${url})\n`;
const marker = "\uE200cite\uE202turn6view0\uE201";
const output = `${header}${marker} [wordlim: 200] Crawled: today;\nL0: Worktrees`;
const link = `[code.claude.com](<${url}>)`;

test("extracts source URLs from legacy and normalized search headers", () => {
	const expected = [{ refId: "turn6view0", url }];
	assert.deepEqual(extractCitationSources(output), expected);
	assert.deepEqual(extractCitationSources(formatSearchOutput(output)), expected);
	assert.deepEqual(extractCitationSources(output.replace(/\n/g, "\r\n")), expected);
});

test("keeps navigation IDs and page link numbers without private citation codes", () => {
	const text = `${output}\nL1: 【29†git worktree†git-scm.com】`;
	const result = formatSearchOutput(text);
	assert.equal(result, text.replace(marker, "Reference: turn6view0"));
	assert.equal(formatSearchOutput(result), result);
});

test("maps each result header, not page URLs or a previous result", () => {
	const text = `${output}\nL1: Example (https://wrong.example)\n${"-".repeat(80)}\n` +
		"Other (https://example.com/path_(test))\n\uE200cite\uE202turn7view1\uE201 [wordlim: 200]";
	assert.deepEqual(extractCitationSources(text), [
		{ refId: "turn6view0", url },
		{ refId: "turn7view1", url: "https://example.com/path_(test)" },
	]);
});

test("converts grouped citations and removes duplicate URLs within a group", () => {
	const sources = new Map([["turn6view0", url], ["turn7view0", url], ["turn7view1", "https://example.com/a_(b)"]]);
	const text = "Claim. \uE200cite\uE202turn6view0\uE202turn7view0\uE202turn7view1\uE201";
	assert.equal(replaceCitations(text, sources), `Claim. ${link} [example.com](<https://example.com/a_(b)>)`);
});

test("does not invent links for missing or unsafe sources", () => {
	assert.equal(replaceCitations(marker, new Map()), "[source: turn6view0; URL unavailable]");
	assert.equal(replaceCitations(marker, new Map([["turn6view0", "javascript:alert(1)"]])),
		"[source: turn6view0; URL unavailable]");
	assert.deepEqual(extractCitationSources(`Unsafe (javascript:alert(1))\n${marker}`), []);
});

test("hides every incomplete streaming prefix and restores the complete link", () => {
	const sources = new Map([["turn6view0", url]]);
	for (let length = 1; length < marker.length; length++) {
		assert.equal(replaceCitations(`Claim. ${marker.slice(0, length)}`, sources, true), "Claim. ");
	}
	assert.equal(replaceCitations(`Claim. ${marker}`, sources, true), `Claim. ${link}`);
	assert.equal(replaceCitations("Claim. \uE200cite\uE202turn6", sources), "Claim. [source unavailable]");
});

function setup() {
	const handlers = new Map<string, Function>();
	let transformer: Function;
	let branch: any[] = [];
	registerCitationHandling({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerMarkdownTransformer: (handler: Function) => { transformer = handler; },
	} as any);
	return {
		emit(event: string, data: any = {}) {
			return handlers.get(event)?.(data, { sessionManager: { getBranch: () => branch } });
		},
		load(entries: any[]) {
			branch = entries;
		},
		render(text: string, messageType = "assistant", isStreaming = false) {
			return transformer(text, { messageType, isStreaming, availableWidth: 80 });
		},
	};
}

function toolMessage(text = output, details?: unknown) {
	return { role: "toolResult", toolName: "codex_web_search", content: [{ type: "text", text }], details };
}

test("restores old sessions and clears sources on branch and session changes", () => {
	const state = setup();
	state.load([{ type: "message", message: toolMessage() }]);
	state.emit("session_start");
	assert.equal(state.render(marker), link);
	state.load([]);
	state.emit("session_tree");
	assert.match(state.render(marker), /URL unavailable/);
	state.emit("tool_result", toolMessage());
	assert.equal(state.render(marker), link);
	state.emit("session_start");
	assert.match(state.render(marker), /URL unavailable/);
});

test("restores truncated sources from tool details after compaction", () => {
	const state = setup();
	state.load([{ type: "message", message: toolMessage("truncated", {
		citationSources: [{ refId: "turn6view0", url }],
	}) }]);
	state.emit("session_compact");
	assert.equal(state.render(marker), link);
});

test("persists only assistant text changes and preserves message metadata", () => {
	const state = setup();
	state.emit("tool_result", toolMessage());
	const thinking = { type: "thinking", thinking: marker, thinkingSignature: "keep" };
	const toolCall = { type: "toolCall", name: "open", arguments: { ref_id: "turn6view0" } };
	const message = { role: "assistant", content: [thinking, { type: "text", text: `Claim. ${marker}` }, toolCall],
		usage: { input: 1 }, timestamp: 123, provider: "openai-codex" };
	const result = state.emit("message_end", { message });
	assert.equal(result.message.content[1].text, `Claim. ${link}`);
	assert.equal(message.content[1].text, `Claim. ${marker}`);
	assert.equal(result.message.content[0], thinking);
	assert.equal(result.message.content[2], toolCall);
	assert.equal(result.message.usage, message.usage);
	assert.equal(result.message.timestamp, 123);
	assert.equal(state.emit("message_end", { message: result.message }), undefined);
});

test("does not transform user messages, thinking, or unrelated tool output", () => {
	const state = setup();
	assert.equal(state.render(marker, "user"), marker);
	assert.equal(state.render(marker, "assistant-thinking"), marker);
	assert.equal(state.emit("message_end", { message: { role: "user", content: marker } }), undefined);
	state.emit("tool_result", { ...toolMessage(), toolName: "read" });
	assert.match(state.render(marker), /URL unavailable/);
});

test("repairs legacy model context without changing saved messages", () => {
	const state = setup();
	const tool = toolMessage();
	state.load([{ type: "message", message: tool }]);
	state.emit("session_start");
	const assistant = { role: "assistant", content: [{ type: "text", text: marker }] };
	const user = { role: "user", content: marker };
	const result = state.emit("context", { messages: [tool, assistant, user] });
	assert.equal(result.messages[0].content[0].text, formatSearchOutput(output));
	assert.equal(result.messages[1].content[0].text, link);
	assert.equal(result.messages[2], user);
	assert.equal(tool.content[0].text, output);
	assert.equal(assistant.content[0].text, marker);
});
