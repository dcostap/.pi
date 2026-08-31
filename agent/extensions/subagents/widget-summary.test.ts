import { describe, expect, test } from "bun:test";
import {
	SUBAGENT_DAY_MS,
	SUBAGENT_HOUR_MS,
	subagentWidgetSummary,
} from "./widget-summary.ts";

const NOW = 2_000_000_000_000;

const records = [
	{ active: true, createdAt: NOW - 10_000, cost: 4 },
	{ active: false, createdAt: NOW - 30 * 60_000, cost: 3 },
	{ active: false, createdAt: NOW - 2 * SUBAGENT_HOUR_MS, cost: 2 },
	{ active: false, createdAt: NOW - 2 * SUBAGENT_DAY_MS, cost: 1 },
];

describe("subagent widget summary", () => {
	test("hides time windows until the parent session is old enough", () => {
		const young = subagentWidgetSummary(records, NOW - SUBAGENT_HOUR_MS + 1, NOW);
		expect(young.lastHour).toBeUndefined();
		expect(young.lastDay).toBeUndefined();

		const hourly = subagentWidgetSummary(records, NOW - SUBAGENT_HOUR_MS, NOW);
		expect(hourly.lastHour).toEqual({ count: 1, cost: 3 });
		expect(hourly.lastDay).toBeUndefined();
	});

	test("shows day and hour counts with costs for matching historical agents", () => {
		const summary = subagentWidgetSummary(records, NOW - SUBAGENT_DAY_MS, NOW);

		expect(summary).toEqual({
			activeCount: 1,
			totalCount: 3,
			activeCost: 4,
			totalCost: 10,
			lastDay: { count: 2, cost: 5 },
			lastHour: { count: 1, cost: 3 },
		});
	});
});
