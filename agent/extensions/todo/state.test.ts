import { describe, expect, test } from "bun:test";
import { TODO_STATE_ENTRY, applyTodoChanges, createTodoState, restoreTodoState } from "./state.ts";

describe("todo state", () => {
	test("adds grouped tasks and command watches with stable IDs", () => {
		const state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "Review drift", group: "Wave 21", every: "15m" },
			{
				action: "add",
				kind: "watch",
				text: "Tests remain green",
				group: "Checks",
				every: "10m",
				schedule_action: "command",
				command: "npm test",
			},
		], 100);

		expect(state.items.map((item) => item.id)).toEqual(["t-1", "w-2"]);
		expect(state.items[0]?.schedule?.action).toBe("remind");
		expect(state.items[1]?.schedule?.timeoutSeconds).toBe(300);
	});

	test("keeps changes atomic when one is invalid", () => {
		const original = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "Keep me" },
		]);
		expect(() => applyTodoChanges(original, [
			{ action: "complete", id: "t-1" },
			{ action: "complete", id: "missing" },
		])).toThrow("Unknown todo item");
		expect(original.items[0]?.done).toBe(false);
	});

	test("does not let a command run from a task", () => {
		expect(() => applyTodoChanges(createTodoState(), [{
			action: "add",
			kind: "task",
			text: "Invalid command task",
			every: "1m",
			schedule_action: "command",
			command: "echo no",
		}])).toThrow("Only watches");
	});

	test("restores the last snapshot on the active branch", () => {
		const first = applyTodoChanges(createTodoState(), [{ action: "add", kind: "task", text: "First" }]);
		const second = applyTodoChanges(first, [{ action: "complete", id: "t-1" }]);
		const restored = restoreTodoState([
			{ type: "custom", customType: TODO_STATE_ENTRY, data: first },
			{ type: "custom", customType: "other", data: {} },
			{ type: "custom", customType: TODO_STATE_ENTRY, data: second },
		]);
		expect(restored.items[0]?.done).toBe(true);
	});

	test("watches cannot be completed", () => {
		const state = applyTodoChanges(createTodoState(), [{ action: "add", kind: "watch", text: "Standing rule" }]);
		expect(() => applyTodoChanges(state, [{ action: "complete", id: "w-1" }])).toThrow("cannot be checked");
	});
});
