import { describe, expect, test } from "bun:test";
import { formatTodoStatus, normalizeTodoStatus } from "./todo-status.ts";

describe("todo status", () => {
	test("formats the current task with one-based progress", () => {
		expect(formatTodoStatus({
			current: { id: "t-44", text: "Review include/panel" },
			completed: 2,
			total: 10,
		})).toBe("○ t-44 Review include/panel 3/10");
	});

	test("formats lists without a current task", () => {
		expect(formatTodoStatus({ completed: 3, total: 10 })).toBe("○ no current 3/10");
	});

	test("normalizes valid status and rejects invalid counts", () => {
		expect(normalizeTodoStatus({ current: { id: " t-1 ", text: " Work " }, completed: 0, total: 1 }))
			.toEqual({ current: { id: "t-1", text: "Work" }, completed: 0, total: 1 });
		expect(normalizeTodoStatus({ completed: 2, total: 1 })).toBeUndefined();
	});
});
