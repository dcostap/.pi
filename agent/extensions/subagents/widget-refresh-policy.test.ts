import { describe, expect, test } from "bun:test";
import { widgetRefreshDelay } from "./widget-refresh-policy.ts";

describe("subagent widget refresh delay", () => {
	test.each([
		[0, 120],
		[5, 120],
		[6, 200],
		[10, 200],
		[11, 350],
		[20, 350],
		[21, 600],
		[40, 600],
		[41, 1_000],
		[100, 1_000],
	])("uses a %i-node tree delay", (nodes, delay) => {
		expect(widgetRefreshDelay(nodes)).toBe(delay);
	});
});
