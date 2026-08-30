import { describe, expect, test } from "bun:test";
import { formatTodoState } from "./format.ts";
import { applyTodoChanges, createTodoState } from "./state.ts";

describe("todo state formatting", () => {
	test("pages active items and identifies an explicit current task", () => {
		const state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "First" },
			{ action: "add", kind: "task", text: "Second" },
			{ action: "add", kind: "task", text: "Third" },
			{ action: "set_current", id: "t-2" },
		]);
		const firstPage = formatTodoState(state, { limit: 2 });
		expect(firstPage).toContain("Current task: t-2 · Second");
		expect(firstPage).toContain("t-2 Second · CURRENT");
		expect(firstPage).toContain("Use todo view with offset 2");
		expect(firstPage).not.toContain("t-3 Third");

		const secondPage = formatTodoState(state, { offset: 2, limit: 2 });
		expect(secondPage).toContain("t-3 Third");
	});

	test("shows no more than seven completed tasks", () => {
		let state = createTodoState();
		for (let index = 1; index <= 9; index++) {
			state = applyTodoChanges(state, [{ action: "add", kind: "task", text: `Task ${index}` }], index);
			state = applyTodoChanges(state, [{ action: "complete", id: `t-${index}` }], 100 + index);
		}
		const output = formatTodoState(state);
		expect(output).toContain("Recently completed (7 of 9)");
		expect(output).not.toContain("t-1 Task 1");
		expect(output).not.toContain("t-2 Task 2");
		expect(output.indexOf("t-3 Task 3")).toBeLessThan(output.indexOf("t-9 Task 9"));
	});

	test("keeps a page below the tool output limit", () => {
		const state = applyTodoChanges(
			createTodoState(),
			Array.from({ length: 60 }, (_, index) => ({
				action: "add" as const,
				kind: "task" as const,
				text: `${index + 1} ${"界".repeat(495)}`,
			})),
		);
		const output = formatTodoState(state, { limit: 60 });
		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(50 * 1024);
		expect(output).toContain("Use todo view with offset");
	});
});
