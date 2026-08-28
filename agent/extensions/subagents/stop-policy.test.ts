import { describe, expect, test } from "bun:test";
import { stopManagedProcessTree, type ManagedProcessStopControl } from "./stop-policy.ts";

function control(events: string[], overrides: Partial<ManagedProcessStopControl> = {}): ManagedProcessStopControl {
	return {
		requestDescendantStop: async () => { events.push("descendants"); },
		abort: async () => { events.push("abort"); },
		waitForCompletion: async () => { events.push("wait"); return true; },
		terminate: async () => { events.push("terminate"); },
		terminateTree: async () => { events.push("tree"); },
		...overrides,
	};
}

describe("managed subtree stop", () => {
	test("stops descendants before it aborts their coordinator", async () => {
		const events: string[] = [];

		const method = await stopManagedProcessTree(control(events));

		expect(method).toBe("recursive");
		expect(events).toEqual(["descendants", "abort", "wait"]);
	});

	test("terminates the operating-system tree when recursive shutdown fails", async () => {
		const events: string[] = [];
		const method = await stopManagedProcessTree(control(events, {
			requestDescendantStop: async () => { events.push("descendants"); throw new Error("RPC failed"); },
		}));

		expect(method).toBe("forced-tree");
		expect(events).toEqual(["descendants", "tree"]);
	});

	test("terminates an unresponsive coordinator after recursive shutdown", async () => {
		const events: string[] = [];
		await stopManagedProcessTree(control(events, {
			waitForCompletion: async () => { events.push("wait"); return false; },
		}));

		expect(events).toEqual(["descendants", "abort", "wait", "terminate"]);
	});
});
