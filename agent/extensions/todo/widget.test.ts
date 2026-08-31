import { describe, expect, test } from "bun:test";
import { applyTodoChanges, createTodoState } from "./state.ts";
import { todoWidgetLines } from "./widget.ts";

const theme = {
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as never;

describe("todo widget", () => {
	test("shows current work before other open tasks", () => {
		const state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "First" },
			{ action: "add", kind: "task", text: "Current" },
			{ action: "set_current", id: "t-2" },
		], 100);
		const output = todoWidgetLines(state, theme, () => undefined, 100).join("\n");
		expect(output.indexOf("t-2 Current")).toBeLessThan(output.indexOf("t-1 First"));
		expect(output).toContain("▶ t-2 Current");
	});

	test("keeps a completed task for one minute", () => {
		let state = applyTodoChanges(createTodoState(), [{ action: "add", kind: "task", text: "Finished" }], 100);
		state = applyTodoChanges(state, [{ action: "complete", id: "t-1" }], 1_000);
		expect(todoWidgetLines(state, theme, () => undefined, 60_999).join("\n")).toContain("t-1 Finished");
		expect(todoWidgetLines(state, theme, () => undefined, 61_000).join("\n")).not.toContain("t-1 Finished");
	});

	test("reserves space for recent completions when many tasks remain open", () => {
		let state = applyTodoChanges(createTodoState(), Array.from({ length: 8 }, (_, index) => ({
			action: "add" as const,
			kind: "task" as const,
			text: `Task ${index + 1}`,
		})), 100);
		state = applyTodoChanges(state, [{ action: "complete", id: "t-8" }], 1_000);
		const output = todoWidgetLines(state, theme, () => undefined, 1_001).join("\n");
		expect(output).toContain("t-8 Task 8");
	});

	test("collapses old completed work to one summary line", () => {
		let state = createTodoState();
		for (let index = 1; index <= 10; index++) {
			state = applyTodoChanges(state, [{ action: "add", kind: "task", text: `Task ${index}` }], index);
			state = applyTodoChanges(state, [{ action: "complete", id: `t-${index}` }], 100 + index);
		}
		const lines = todoWidgetLines(state, theme, () => undefined, 100_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("✓ 10/10 complete");
	});

	test("shows failed watches but hides healthy watches", () => {
		let state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "watch", text: "Healthy" },
			{ action: "add", kind: "watch", text: "Broken" },
		]);
		state.items[0]!.lastRun = { startedAt: 1, finishedAt: 2, status: "success", output: "", totalBytes: 0, totalLines: 0, truncated: false };
		state.items[1]!.lastRun = { startedAt: 1, finishedAt: 2, status: "failed", output: "", totalBytes: 0, totalLines: 0, truncated: false };
		const output = todoWidgetLines(state, theme, () => undefined, 100).join("\n");
		expect(output).not.toContain("w-1 Healthy");
		expect(output).toContain("w-2 Broken");
	});
});
