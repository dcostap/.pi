import { describe, expect, test } from "bun:test";
import { activePath, convertTranscript, mapToolCall, type CcRow } from "./convert.ts";

let clock = Date.parse("2026-10-01T10:00:00.000Z");
const base = (uuid: string, parentUuid: string | null) => ({
	uuid,
	parentUuid,
	isSidechain: false,
	timestamp: new Date(clock += 1000).toISOString(),
	cwd: "C:\\Projects\\demo",
	sessionId: "s1",
});
const user = (uuid: string, parent: string | null, content: unknown, extra: CcRow = {}): CcRow => ({ ...base(uuid, parent), type: "user", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, parent: string | null, messageId: string, block: unknown, extra: CcRow = {}): CcRow => ({
	...base(uuid, parent),
	type: "assistant",
	effort: "high",
	message: {
		id: messageId,
		model: "claude-opus-5-5",
		role: "assistant",
		content: [block],
		stop_reason: (block as any).type === "tool_use" ? "tool_use" : "end_turn",
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
	},
	...extra,
});
const result = (uuid: string, parent: string, callId: string, content: unknown = "done", isError = false) =>
	user(uuid, parent, [{ type: "tool_result", tool_use_id: callId, content, is_error: isError }]);
const toolUse = (id: string, name = "Bash", input: unknown = { command: "ls" }) => ({ type: "tool_use", id, name, input });
const messages = (rows: CcRow[]) => convertTranscript(rows, "s1")!.entries.filter((entry) => entry.type === "message").map((entry) => entry.message);

describe("activePath", () => {
	test("follows the last branch after a rewind", () => {
		const rows = [
			user("u1", null, "first"),
			assistant("a1", "u1", "m1", { type: "text", text: "one" }),
			user("u2", "a1", "abandoned"),
			assistant("a2", "u2", "m2", { type: "text", text: "old" }),
			user("u3", "a1", "rewritten"),
			assistant("a3", "u3", "m3", { type: "text", text: "new" }),
		];
		expect(activePath(rows).map((row) => row.uuid)).toEqual(["u1", "a1", "u3", "a3"]);
	});

	test("continues before a compaction boundary without looping", () => {
		const rows: CcRow[] = [
			user("u1", null, "first"),
			assistant("a1", "u1", "m1", { type: "text", text: "one" }),
			{ ...base("b1", null), type: "system", subtype: "compact_boundary", logicalParentUuid: "t1", compactMetadata: { preTokens: 500, preservedMessages: { uuids: ["a1", "t1"] } } },
			user("cs", "b1", "Summary text", { isCompactSummary: true }),
			{ ...base("t1", "cs"), type: "attachment", attachment: { type: "date" } },
			user("u2", "t1", "after"),
		];
		expect(activePath(rows).map((row) => row.uuid)).toEqual(["u1", "a1", "b1", "cs", "t1", "u2"]);
	});
});

describe("convertTranscript", () => {
	test("merges block rows of one assistant message and keeps call order", () => {
		const rows = [
			user("u1", null, "run two commands"),
			assistant("a1", "u1", "m1", { type: "thinking", thinking: "plan", signature: "sig" }),
			assistant("a2", "a1", "m1", toolUse("c1")),
			result("r1", "a2", "c1", "out1"),
			assistant("a3", "r1", "m1", toolUse("c2", "Read", { file_path: "x.ts", offset: 2 })),
			result("r2", "a3", "c2", [{ type: "text", text: "file" }]),
			assistant("a4", "r2", "m2", { type: "text", text: "all done" }),
		];
		const out = messages(rows);
		expect(out.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(out[1].content).toEqual([
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "x.ts", offset: 2 } },
		]);
		expect(out[1].stopReason).toBe("toolUse");
		expect(out[1].usage).toMatchObject({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135 });
		expect(out[2]).toMatchObject({ toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out1" }], isError: false });
		expect(out[3]).toMatchObject({ toolCallId: "c2", toolName: "read" });
		expect(out[4]).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "all done" }] });
	});

	test("places a prompt queued mid-turn after the pending tool result", () => {
		const rows: CcRow[] = [
			user("u1", null, "start"),
			assistant("a1", "u1", "m1", toolUse("c1")),
			{ ...base("q1", "a1"), type: "attachment", attachment: { type: "queued_command", prompt: "also check tests", commandMode: "prompt" } },
			result("r1", "q1", "c1"),
			assistant("a2", "r1", "m2", { type: "text", text: "ok" }),
		];
		expect(messages(rows).map((message) => message.role === "user" ? `user:${message.content}` : message.role))
			.toEqual(["user:start", "assistant", "toolResult", "user:also check tests", "assistant"]);
	});

	test("adds an error result for a call that never got one", () => {
		const rows = [
			user("u1", null, "start"),
			assistant("a1", "u1", "m1", toolUse("c1")),
			user("u2", "a1", "[Request interrupted by user]"),
		];
		const out = messages(rows);
		expect(out.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(out[2]).toMatchObject({ toolCallId: "c1", toolName: "bash", isError: true });
	});

	test("skips meta rows and maps images", () => {
		const rows = [
			user("u1", null, [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }]),
			user("m1", "u1", "[Image: original 10x10]", { isMeta: true }),
			assistant("a1", "m1", "m1x", { type: "text", text: "nice" }),
		];
		const out = messages(rows);
		expect(out).toHaveLength(2);
		expect(out[0].content).toEqual([{ type: "text", text: "look" }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }]);
	});

	test("turns a compaction summary into a compaction entry", () => {
		const rows: CcRow[] = [
			user("u1", null, "first"),
			assistant("a1", "u1", "m1", { type: "text", text: "one" }),
			user("u2", "a1", "second"),
			{ ...base("b1", null), type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 900, preservedMessages: { uuids: ["u2"] } } },
			user("cs", "b1", "Summary of earlier work", { isCompactSummary: true }),
			user("u3", "cs", "third"),
		];
		const entries = convertTranscript(rows, "s1")!.entries;
		const compaction = entries.find((entry) => entry.type === "compaction")!;
		const kept = entries.find((entry) => entry.message?.content === "second")!;
		expect(compaction).toMatchObject({ summary: "Summary of earlier work", tokensBefore: 900, firstKeptEntryId: kept.id });
		expect(entries.indexOf(compaction)).toBeGreaterThan(entries.indexOf(kept));
	});

	test("writes model, thinking level, title, and a linear parent chain", () => {
		const rows: CcRow[] = [
			user("u1", null, "hi"),
			assistant("a1", "u1", "m1", { type: "text", text: "hello" }),
			{ type: "ai-title", aiTitle: "Greeting", sessionId: "s1" },
		];
		const converted = convertTranscript(rows, "s1")!;
		expect(converted.header).toMatchObject({ type: "session", version: 3, id: "s1", cwd: "C:\\Projects\\demo" });
		expect(converted.entries.map((entry) => entry.type)).toEqual(["message", "model_change", "thinking_level_change", "message", "session_info"]);
		expect(converted.entries[1]).toMatchObject({ provider: "anthropic", modelId: "claude-opus-5-5" });
		expect(converted.entries[2]).toMatchObject({ thinkingLevel: "high" });
		expect(converted.entries[4]).toMatchObject({ name: "[Claude] Greeting" });
		converted.entries.forEach((entry, index) => expect(entry.parentId).toBe(index === 0 ? null : converted.entries[index - 1]!.id));
	});

	test("marks API error messages as errors", () => {
		const rows = [
			user("u1", null, "hi"),
			assistant("a1", "u1", "e1", { type: "text", text: "You've hit your limit" }, { isApiErrorMessage: true, message: { id: "e1", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }], stop_reason: "stop_sequence" } }),
		];
		expect(messages(rows)[1]).toMatchObject({ stopReason: "error", errorMessage: "You've hit your limit" });
	});

	test("is deterministic", () => {
		const rows = [user("u1", null, "hi"), assistant("a1", "u1", "m1", { type: "text", text: "hello" })];
		expect(JSON.stringify(convertTranscript(rows, "s1"))).toBe(JSON.stringify(convertTranscript(rows, "s1")));
	});

	test("returns undefined for a transcript without messages", () => {
		expect(convertTranscript([{ type: "mode", mode: "normal" }], "s1")).toBeUndefined();
	});
});

describe("mapToolCall", () => {
	test("maps Claude Code built-ins to Pi tools", () => {
		expect(mapToolCall("Bash", { command: "ls", timeout: 120000, description: "x" })).toEqual({ name: "bash", arguments: { command: "ls", timeout: 120 } });
		expect(mapToolCall("Write", { file_path: "a", content: "b" })).toEqual({ name: "write", arguments: { path: "a", content: "b" } });
		expect(mapToolCall("Edit", { file_path: "a", old_string: "x", new_string: "y" })).toEqual({ name: "edit", arguments: { path: "a", edits: [{ oldText: "x", newText: "y" }] } });
		expect(mapToolCall("Grep", { pattern: "x" })).toEqual({ name: "Grep", arguments: { pattern: "x" } });
		expect(mapToolCall("mcp__pi-bridge__subagent_list", {})).toEqual({ name: "subagent_list", arguments: {} });
	});
});
