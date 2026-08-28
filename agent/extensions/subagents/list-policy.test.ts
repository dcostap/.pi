import { describe, expect, test } from "bun:test";
import { MAX_RECENT_COMPLETED_SUBAGENTS, partitionSubagentList } from "./list-policy.ts";

describe("subagent list policy", () => {
	test("keeps every active entry and only ten recent completed entries", () => {
		const items = [
			...Array.from({ length: 15 }, (_, index) => ({ id: `active-${index}`, state: "running", updatedAt: index })),
			...Array.from({ length: 14 }, (_, index) => ({ id: `done-${index}`, state: "cold", settledAt: index, updatedAt: index })),
		];
		const result = partitionSubagentList(items);

		expect(MAX_RECENT_COMPLETED_SUBAGENTS).toBe(10);
		expect(result.active).toHaveLength(15);
		expect(result.completed.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `done-${13 - index}`));
		expect(result.omittedCompleted).toBe(4);
	});
});
