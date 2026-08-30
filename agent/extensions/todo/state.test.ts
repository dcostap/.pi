import { describe, expect, test } from "bun:test";
import { TODO_STATE_ENTRY, applyTodoChanges, createTodoState, getCurrentTaskId, getRecentCompletedTasks, restoreTodoState } from "./state.ts";

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

	test("sets current task independently from list order", () => {
		let state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "watch", text: "Watch first" },
			{ action: "add", kind: "task", text: "First task" },
			{ action: "add", kind: "task", text: "Second task" },
		]);
		expect(getCurrentTaskId(state)).toBeUndefined();

		state = applyTodoChanges(state, [{ action: "set_current", id: "t-3" }]);
		expect(getCurrentTaskId(state)).toBe("t-3");
		expect(state.items.map((item) => item.id)).toEqual(["w-1", "t-2", "t-3"]);

		state = applyTodoChanges(state, [{ action: "complete", id: "t-3" }]);
		expect(getCurrentTaskId(state)).toBeUndefined();
	});

	test("rejects completed tasks as current and can clear current", () => {
		let state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "Open" },
			{ action: "add", kind: "task", text: "Done" },
			{ action: "complete", id: "t-2" },
			{ action: "set_current", id: "t-1" },
		]);
		expect(() => applyTodoChanges(state, [{ action: "set_current", id: "t-2" }])).toThrow("cannot be current");
		const withWatch = applyTodoChanges(state, [{ action: "add", kind: "watch", text: "Watch" }]);
		expect(() => applyTodoChanges(withWatch, [{ action: "set_current", id: "w-3" }])).toThrow("cannot be current");
		state = applyTodoChanges(state, [{ action: "clear_current" }]);
		expect(getCurrentTaskId(state)).toBeUndefined();
	});

	test("keeps the four latest completed tasks in completion order", () => {
		let state = createTodoState();
		for (let index = 1; index <= 6; index++) {
			state = applyTodoChanges(state, [{ action: "add", kind: "task", text: `Task ${index}` }], index);
			state = applyTodoChanges(state, [{ action: "complete", id: `t-${index}` }], 100 + index);
		}
		expect(getRecentCompletedTasks(state).map((item) => item.id)).toEqual(["t-3", "t-4", "t-5", "t-6"]);
	});
});
