import { describe, expect, test } from "bun:test";
import { cacheHitRate, completionTokens, formatCacheHitRate } from "./completion.ts";

describe("subagent completion accounting", () => {
	test("matches Pi's cache-hit rate formula and formatting", () => {
		expect(cacheHitRate({ input: 8, cacheRead: 91, cacheWrite: 1 })).toBeCloseTo(91, 10);
		expect(formatCacheHitRate(99.2, true)).toBe("CH99.2%");
		expect(formatCacheHitRate(0, false)).toBe("");
	});

	test("sums stored usage for user-facing accounting", () => {
		expect(completionTokens({ input: 8, output: 2, cacheRead: 91, cacheWrite: 1, cost: 0, turns: 1 })).toBe(102);
	});
});
