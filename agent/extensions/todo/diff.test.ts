import { describe, expect, test } from "bun:test";
import { buildTodoDiff } from "./diff.ts";
import { applyTodoChanges, createTodoState } from "./state.ts";

describe("todo diffs", () => {
	test("shows current, completion, and added item changes", () => {
		const before = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "First" },
			{ action: "add", kind: "task", text: "Second" },
			{ action: "set_current", id: "t-1" },
		]);
		const changes = [
			{ action: "complete" as const, id: "t-1" },
			{ action: "set_current" as const, id: "t-2" },
			{ action: "add" as const, kind: "task" as const, text: "Third" },
		];
		const after = applyTodoChanges(before, changes);
		const lines = buildTodoDiff(before, after, changes);
		expect(lines).toContainEqual({ kind: "remove", text: "CURRENT t-1 · First" });
		expect(lines).toContainEqual({ kind: "add", text: "CURRENT t-2 · Second" });
		expect(lines).toContainEqual({ kind: "remove", text: "[ ] t-1 First" });
		expect(lines).toContainEqual({ kind: "add", text: "[x] t-1 First" });
		expect(lines).toContainEqual({ kind: "add", text: "[ ] t-3 Third" });
	});

	test("shows a move without treating shifted items as edited", () => {
		const before = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "First" },
			{ action: "add", kind: "task", text: "Second" },
		]);
		const changes = [{ action: "move" as const, id: "t-2", before_id: "t-1" }];
		const after = applyTodoChanges(before, changes);
		expect(buildTodoDiff(before, after, changes)).toEqual([
			{ kind: "move", text: "moved t-2 before t-1" },
		]);
	});
});
