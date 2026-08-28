import { describe, expect, test } from "bun:test";
import { isLiveMessageTarget, parseSubagentSendSelector } from "./send-policy.ts";

describe("subagent message selectors", () => {
	test("requires exactly one explicit selector", () => {
		expect(() => parseSubagentSendSelector({})).toThrow("exactly one");
		expect(() => parseSubagentSendSelector({ id: "sa-one", batch_id: "batch-one" })).toThrow("exactly one");
	});

	test("requires an explicit true value for broad delivery", () => {
		expect(() => parseSubagentSendSelector({ all_active_and_parked: false })).toThrow("must be true");
		expect(parseSubagentSendSelector({ all_active_and_parked: true })).toEqual({ kind: "all_active_and_parked" });
	});

	test("deduplicates explicit ids", () => {
		expect(parseSubagentSendSelector({ ids: ["sa-one", "sa-one", "sa-two"] })).toEqual({
			kind: "ids",
			ids: ["sa-one", "sa-two"],
		});
	});

	test("limits broad delivery to live and parked work", () => {
		expect(["starting", "running", "parked"].every(isLiveMessageTarget)).toBe(true);
		expect(["queued", "stopping", "cold"].some(isLiveMessageTarget)).toBe(false);
	});
});
