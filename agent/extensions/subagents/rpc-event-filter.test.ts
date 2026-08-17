import { describe, expect, test } from "bun:test";
import { isUnusedRpcStreamEvent } from "./rpc-event-filter.ts";

function event(value: unknown): string {
	return JSON.stringify(value);
}

describe("managed subagent RPC event filtering", () => {
	test("drops unused assistant stream deltas", () => {
		for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) {
			expect(isUnusedRpcStreamEvent(event({
				type: "message_update",
				assistantMessageEvent: { type, contentIndex: 0, delta: "chunk" },
			}))).toBe(true);
		}
	});

	test("drops accumulated tool progress updates", () => {
		expect(isUnusedRpcStreamEvent(event({
			type: "tool_execution_update",
			toolCallId: "call-1",
			partialResult: { content: [{ type: "text", text: "accumulated output" }] },
		}))).toBe(true);
	});

	test("keeps status starts and authoritative final events", () => {
		const kept = [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
			{ type: "message_end", message: { role: "assistant" } },
			{ type: "tool_execution_start", toolCallId: "call-1" },
			{ type: "tool_execution_end", toolCallId: "call-1" },
			{ type: "agent_settled" },
			{ type: "response", id: "request-1", success: true },
		];
		for (const value of kept) expect(isUnusedRpcStreamEvent(event(value))).toBe(false);
	});

	test("uses normal parsing when the protocol shape is not canonical", () => {
		const spaced = '{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "chunk" } }';
		expect(isUnusedRpcStreamEvent(spaced)).toBe(false);
	});
});
