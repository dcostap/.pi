import { describe, expect, test } from "bun:test";

import { buildSessionFamily, type SessionFamilyNode } from "../startup-frontpage";

function node(path: string, parentPath?: string, day = 1): SessionFamilyNode {
	return {
		path,
		id: path,
		timestamp: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
		parentPath,
		children: [],
	};
}

describe("buildSessionFamily", () => {
	test("returns the full hierarchy containing the current session", () => {
		const root = node("/sessions/root");
		const first = node("/sessions/first", root.path, 2);
		const current = node("/sessions/current", first.path, 3);
		const sibling = node("/sessions/sibling", root.path, 4);
		const unrelated = node("/sessions/unrelated");

		const family = buildSessionFamily([unrelated, current, sibling, root, first], current.path);

		expect(family).toBe(root);
		expect(root.children).toEqual([first, sibling]);
		expect(first.children).toEqual([current]);
		expect(unrelated.children).toEqual([]);
	});

	test("handles Windows separator and case differences", () => {
		const root = node("C:\\Sessions\\Root.jsonl");
		const current = node("C:\\Sessions\\Child.jsonl", "c:/sessions/root.jsonl");

		const family = buildSessionFamily([current, root], "c:/SESSIONS/child.jsonl");

		if (process.platform === "win32") {
			expect(family).toBe(root);
			expect(root.children).toEqual([current]);
		} else {
			expect(family).toBeUndefined();
		}
	});

	test("does not recurse forever on malformed parent cycles", () => {
		const first = node("/sessions/first", "/sessions/second");
		const second = node("/sessions/second", "/sessions/first");

		const family = buildSessionFamily([first, second], first.path);

		expect(family).toBeDefined();
	});
});
