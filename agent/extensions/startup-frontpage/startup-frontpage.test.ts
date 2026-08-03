import { describe, expect, test } from "bun:test";

import {
	buildSessionFamily,
	limitedRootedHierarchyLines,
	rootedHierarchyLines,
	type SessionFamilyNode,
} from "../startup-frontpage";

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
		expect(root.children).toEqual([sibling, first]);
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

	test("indents the session tree beneath a synthetic cwd root", () => {
		const root = node("/sessions/root");
		const first = node("/sessions/first", root.path, 2);
		const second = node("/sessions/second", root.path, 3);
		buildSessionFamily([root, first, second], second.path);

		const rows = rootedHierarchyLines(root);

		expect(rows.map(({ prefix }) => prefix)).toEqual(["└─ ", "   ├─ ", "   └─ "]);
		expect(rows.map(({ node: rowNode }) => rowNode)).toEqual([root, second, first]);
	});

	test("sorts siblings by last activity", () => {
		const root = node("/sessions/root");
		const older = node("/sessions/older", root.path, 3);
		const newer = node("/sessions/newer", root.path, 2);
		older.modifiedAt = Date.parse("2026-02-01T00:00:00.000Z");
		newer.modifiedAt = Date.parse("2026-03-01T00:00:00.000Z");

		buildSessionFamily([root, older, newer], older.path);

		expect(root.children).toEqual([newer, older]);
	});

	test("caps the tree while retaining the current lineage", () => {
		const root = node("/sessions/root");
		const parent = node("/sessions/parent", root.path, 2);
		const current = node("/sessions/current", parent.path, 3);
		const recent = node("/sessions/recent", root.path, 9);
		const stale = node("/sessions/stale", root.path, 4);
		buildSessionFamily([root, parent, current, stale, recent], current.path);

		const rows = limitedRootedHierarchyLines(root, current.path, 4);

		expect(rows).toHaveLength(4);
		expect(rows.filter((row) => row.node).map((row) => row.node)).toEqual([root, parent, current]);
		expect(rows.find((row) => row.hiddenCount !== undefined)?.hiddenCount).toBe(2);
	});

	test("keeps the current session visible when its lineage exceeds the cap", () => {
		const root = node("/sessions/root");
		const first = node("/sessions/first", root.path, 2);
		const second = node("/sessions/second", first.path, 3);
		const current = node("/sessions/current", second.path, 4);
		buildSessionFamily([root, first, second, current], current.path);

		const rows = limitedRootedHierarchyLines(root, current.path, 3);

		expect(rows).toHaveLength(3);
		expect(rows.filter((row) => row.node).map((row) => row.node)).toEqual([root, current]);
		expect(rows.find((row) => row.hiddenCount !== undefined)?.hiddenCount).toBe(2);
	});

	test("places hidden counts under the visible branch that owns them", () => {
		const root = node("/sessions/root");
		const current = node("/sessions/current", root.path, 3);
		const branch = node("/sessions/branch", root.path, 2);
		const firstHidden = node("/sessions/first-hidden", branch.path, 4);
		const secondHidden = node("/sessions/second-hidden", branch.path, 5);
		const recent = node("/sessions/recent", root.path, 6);
		buildSessionFamily([root, current, branch, firstHidden, secondHidden, recent], current.path);

		const rows = limitedRootedHierarchyLines(root, current.path, 5);
		const summaryIndex = rows.findIndex((row) => row.hiddenCount !== undefined);
		const branchIndex = rows.findIndex((row) => row.node === branch);

		expect(rows).toHaveLength(5);
		expect(rows[summaryIndex]!.hiddenCount).toBe(2);
		expect(summaryIndex).toBeGreaterThan(branchIndex);
		expect(rows[summaryIndex]!.prefix.length).toBeGreaterThan(rows[branchIndex]!.prefix.length);
	});

	test("accounts for every omitted session in a large family", () => {
		const root = node("/sessions/root");
		const children = Array.from({ length: 100 }, (_, index) => (
			node(`/sessions/child-${index}`, root.path, (index % 28) + 1)
		));
		const current = children[0]!;
		buildSessionFamily([root, ...children], current.path);

		const rows = limitedRootedHierarchyLines(root, current.path, 15);
		const visibleNodes = rows.filter((row) => row.node !== undefined).length;
		const hiddenNodes = rows.reduce((total, row) => total + (row.hiddenCount ?? 0), 0);

		expect(rows).toHaveLength(15);
		expect(rows.some((row) => row.node === current)).toBe(true);
		expect(visibleNodes + hiddenNodes).toBe(101);
	});
});
