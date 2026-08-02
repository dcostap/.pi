import { describe, expect, test } from "bun:test";
import { cacheHitRate, formatCacheHitRate, formatCompletionBatch, type CompletionSnapshot } from "./completion.ts";

function snapshot(id: string, outcome: CompletionSnapshot["outcome"], answer: string): CompletionSnapshot {
	return {
		id,
		title: `Agent ${id}`,
		profile: "review",
		outcome,
		model: "provider/model-id",
		thinking: "high",
		runId: `${id}-r1`,
		task: "Review target",
		activity: outcome,
		createdAt: 0,
		startedAt: 0,
		settledAt: 2000,
		durationMs: 2000,
		attempts: 1,
		usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, latestCacheHitRate: 99.2, cost: 0.01, turns: 2 },
		finalAnswer: answer,
		error: outcome === "failed" ? "provider failed" : undefined,
		sessionFile: `C:/sessions/${id}.jsonl`,
	};
}

describe("completion batches", () => {
	test("combines all final answers and accumulated metrics", () => {
		const text = formatCompletionBatch([
			snapshot("sa-1", "completed", "First answer"),
			snapshot("sa-2", "completed", "Second answer"),
		]);
		expect(text).toContain("Agents: 2 · failures: 0");
		expect(text).toContain("Tokens: 300");
		expect(text).toContain("First answer");
		expect(text).toContain("Second answer");
		expect(text).toContain("provider/model-id [high]");
		expect(text).toContain("CH99.2%");
		expect(text).toContain("2.0s");
	});

	test("matches Pi's cache-hit rate formula and formatting", () => {
		expect(cacheHitRate({ input: 8, cacheRead: 91, cacheWrite: 1 })).toBeCloseTo(91, 10);
		expect(formatCacheHitRate(99.2, true)).toBe("CH99.2%");
		expect(formatCacheHitRate(0, false)).toBe("");
	});

	test("uses a failed agent's error in the integrated result", () => {
		const text = formatCompletionBatch([snapshot("sa-1", "failed", "partial")]);
		expect(text).toContain("failures: 1");
		expect(text).toContain("provider failed");
	});
});
