import { describe, expect, test } from "bun:test";
import { MAX_LISTED_SUBAGENTS, takeRecent } from "./list-policy.ts";

describe("subagent list policy", () => {
	test("keeps all items within the limit", () => {
		const result = takeRecent(["a", "b"]);

		expect(result.items).toEqual(["a", "b"]);
		expect(result.omitted).toBe(0);
	});

	test("keeps only the most recent items", () => {
		const items = Array.from({ length: MAX_LISTED_SUBAGENTS + 3 }, (_, index) => index);
		const result = takeRecent(items);

		expect(result.items).toHaveLength(MAX_LISTED_SUBAGENTS);
		expect(result.items[0]).toBe(3);
		expect(result.items.at(-1)).toBe(MAX_LISTED_SUBAGENTS + 2);
		expect(result.omitted).toBe(3);
	});
});
