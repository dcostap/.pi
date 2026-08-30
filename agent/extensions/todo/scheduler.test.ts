import { describe, expect, test } from "bun:test";
import { TodoScheduler } from "./scheduler.ts";
import { applyTodoChanges, createTodoState } from "./state.ts";

describe("todo scheduler", () => {
	test("starts intervals from activation and fires due items", async () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		let delay = -1;
		const fired: string[] = [];
		const scheduler = new TodoScheduler({
			now: () => now,
			setTimer: ((fn: () => void, ms: number) => {
				callback = fn;
				delay = ms;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			clearTimer: (() => {}) as typeof clearTimeout,
			onDue: (item) => { fired.push(item.id); },
		});
		const state = applyTodoChanges(createTodoState(), [{
			action: "add", kind: "task", text: "Reminder", every: "10s",
		}]);
		scheduler.start({ ...state, enabled: true });
		expect(delay).toBe(10_000);
		now += 10_000;
		callback?.();
		await Promise.resolve();
		expect(fired).toEqual(["t-1"]);
		scheduler.stop();
	});

	test("does not schedule completed tasks or disabled command scripts", () => {
		let timerCount = 0;
		const scheduler = new TodoScheduler({
			setTimer: ((() => {
				timerCount++;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as unknown) as typeof setTimeout,
			clearTimer: (() => {}) as typeof clearTimeout,
			onDue: () => {},
		});
		let state = applyTodoChanges(createTodoState(), [
			{ action: "add", kind: "task", text: "Done", every: "1m" },
			{ action: "complete", id: "t-1" },
			{ action: "add", kind: "watch", text: "Check", every: "1m", schedule_action: "command", command: "echo ok" },
		]);
		state = { ...state, enabled: true, scriptsEnabled: false };
		scheduler.start(state);
		expect(timerCount).toBe(0);
	});
});
