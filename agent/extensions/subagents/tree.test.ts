import { describe, expect, test } from "bun:test";
import { buildHierarchyLevels, buildVisibleTree, type TreeItem } from "./tree.ts";

type Item = TreeItem & { label: string };

const item = (id: string, parentId: string | undefined, active: boolean, createdAt: number): Item => ({ id, parentId, active, createdAt, label: id });

describe("subagent hierarchy", () => {
	test("counts agent levels without synthetic batch rows", () => {
		const levels = buildHierarchyLevels([
			{ id: "direct" },
			{ id: "child", parentId: "direct" },
			{ id: "grandchild", parentId: "child" },
			{ id: "batch-member" },
		]);
		expect([...levels.entries()]).toEqual([
			["direct", 1],
			["child", 2],
			["grandchild", 3],
			["batch-member", 1],
		]);
	});

	test("keeps inactive ancestors of active descendants", () => {
		const tree = buildVisibleTree([
			item("parent", undefined, false, 1),
			item("child", "parent", true, 2),
			item("inactive-sibling", "parent", false, 3),
		], 12);
		expect(tree.rows.map((row) => row.item.id)).toEqual(["parent", "child"]);
		expect(tree.rows[1]?.prefix).toBe("   ");
	});

	test("renders agents beneath a synthetic batch node", () => {
		const tree = buildVisibleTree([
			item("batch-1", undefined, false, 1),
			item("sa-1", "batch-1", true, 2),
			item("standalone", undefined, true, 3),
		], 12);
		expect(tree.rows.map((row) => row.item.id)).toEqual(["batch-1", "sa-1", "standalone"]);
		expect(tree.rows[1]?.prefix).toBe("│  ");
	});

	test("bounds visible nodes and reports overflow", () => {
		const tree = buildVisibleTree(Array.from({ length: 15 }, (_, index) => item(`node-${index}`, undefined, true, index)), 12);
		expect(tree.rows).toHaveLength(12);
		expect(tree.omitted).toBe(3);
	});

	test("breaks malformed parent cycles", () => {
		const tree = buildVisibleTree([
			item("a", "b", true, 1),
			item("b", "a", false, 2),
		], 12);
		expect(tree.visibleCount).toBe(2);
		expect(tree.rows.length).toBeLessThanOrEqual(2);
	});
});
