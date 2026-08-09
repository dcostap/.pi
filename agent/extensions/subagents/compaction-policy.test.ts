import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	shouldCancelManagedSubagentCompaction,
	shouldCompactBeforeContinuation,
} from "./compaction-policy.ts";

describe("managed subagent compaction policy", () => {
	test("defers only post-answer threshold compaction", () => {
		expect(shouldCancelManagedSubagentCompaction({ reason: "threshold", willRetry: false })).toBe(true);
		expect(shouldCancelManagedSubagentCompaction({ reason: "threshold", willRetry: true })).toBe(false);
		expect(shouldCancelManagedSubagentCompaction({ reason: "overflow", willRetry: true })).toBe(false);
		expect(shouldCancelManagedSubagentCompaction({ reason: "manual", willRetry: false })).toBe(false);
	});

	test("runs deferred compaction only when a continuation starts above the configured threshold", () => {
		const policy = { enabled: true, reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS };
		expect(shouldCompactBeforeContinuation(1, { tokens: 260_000, contextWindow: 272_000 }, policy)).toBe(false);
		expect(shouldCompactBeforeContinuation(2, { tokens: 250_000, contextWindow: 272_000 }, policy)).toBe(false);
		expect(shouldCompactBeforeContinuation(2, { tokens: 260_000, contextWindow: 272_000 }, policy)).toBe(true);
		expect(shouldCompactBeforeContinuation(2, { tokens: 260_000, contextWindow: 272_000 }, { ...policy, enabled: false })).toBe(false);
	});
});
