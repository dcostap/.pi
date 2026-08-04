import { describe, expect, test } from "bun:test";
import { renderAlignedTable, renderIndentedAlignedTable, type AlignedColumn } from "../_shared/aligned-table.ts";

const visibleWidth = (value: string): number => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length;
const truncate = (value: string, width: number): string => {
	if (visibleWidth(value) <= width) return value;
	return width <= 1 ? "…".slice(0, width) : `${value.slice(0, width - 1)}…`;
};

const columns: readonly AlignedColumn<"state" | "id" | "title" | "cost">[] = [
	{ key: "state", minWidth: 7 },
	{ key: "id", minWidth: 5 },
	{ key: "title", maxWidth: 24, minWidth: 8, shrinkPriority: 2 },
	{ key: "cost", align: "right", minWidth: 5, optional: true, hidePriority: 1 },
];

describe("aligned subagent tables", () => {
	test("sizes columns from all rows and pads styled values by display width", () => {
		const rows = renderAlignedTable([
			{ state: "running", id: "sa-1", title: "short", cost: "" },
			{ state: "done", id: "sa-200", title: "longer title", cost: " $0.031" },
		], 80, columns, { visibleWidth, truncate });

		const firstTitleStart = rows[0]!.indexOf("short");
		const secondTitleStart = rows[1]!.indexOf("longer title");
		expect(firstTitleStart).toBe(secondTitleStart);
		expect(rows[0]!.indexOf("$0.031")).toBe(-1);
		expect(rows[1]!.endsWith("$0.031")).toBe(true);

		const styled = renderAlignedTable([
			{ state: "\x1b[31mrun\x1b[0m", id: "a", title: "one", cost: "" },
			{ state: "\x1b[31mlonger\x1b[0m", id: "b", title: "two", cost: "" },
		], 80, columns, { visibleWidth, truncate });
		expect(visibleWidth(styled[0]!)).toBe(visibleWidth(styled[1]!));
	});

	test("shrinks flexible columns and hides optional metrics when needed", () => {
		const rows = renderAlignedTable([
			{ state: "running", id: "sa-1", title: "a deliberately long title", cost: " $0.031" },
			{ state: "running", id: "sa-2", title: "another deliberately long title", cost: " $0.032" },
		], 28, columns, { visibleWidth, truncate });

		expect(rows.every((row) => visibleWidth(row) <= 28)).toBe(true);
		expect(rows[0]!.includes("$0.031")).toBe(false);
	});

	test("keeps data columns aligned while indenting the tree connector", () => {
		type Key = "indent" | "connector" | "state" | "id";
		const treeColumns: readonly AlignedColumn<Key>[] = [
			{ key: "connector", minWidth: 3 },
			{ key: "state" },
			{ key: "id" },
		];
		const rows = renderIndentedAlignedTable<Key>([
			{ indent: "", connector: "└─ ", state: "running", id: "batch-1" },
			{ indent: "   ", connector: "├─ ", state: "running", id: "sa-1" },
			{ indent: "   ", connector: "└─ ", state: "running", id: "sa-2" },
		], 80, treeColumns, { visibleWidth, truncate }, (row) => row.indent);

		expect(rows[0]!.startsWith("└─ ")).toBe(true);
		expect(rows[1]!.startsWith("   ├─ ")).toBe(true);
		expect(rows[2]!.startsWith("   └─ ")).toBe(true);
		expect(rows[1]!.indexOf("sa-1")).toBe(rows[0]!.indexOf("batch-1"));
		expect(rows[2]!.indexOf("sa-2")).toBe(rows[0]!.indexOf("batch-1"));
	});
});
