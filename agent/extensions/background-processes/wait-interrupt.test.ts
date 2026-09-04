import { describe, expect, test } from "bun:test";
import { WaitInterruptRegistry } from "../_shared/wait-interrupt.ts";

describe("background wait interruption", () => {
	test("interrupts every active wait for steering", () => {
		const registry = new WaitInterruptRegistry();
		const first = registry.begin();
		const second = registry.begin();

		registry.interruptForSteer();

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(first.reason()).toBe("steer");
		first.dispose();
		second.dispose();
	});

	test("preserves ordinary agent cancellation", () => {
		const registry = new WaitInterruptRegistry();
		const controller = new AbortController();
		const wait = registry.begin(controller.signal);

		controller.abort();

		expect(wait.signal.aborted).toBe(true);
		expect(wait.reason()).toBe("abort");
		wait.dispose();
	});
});
