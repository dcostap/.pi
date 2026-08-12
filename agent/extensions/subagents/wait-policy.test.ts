import { describe, expect, test } from "bun:test";
import { incrementalWaitState } from "./wait-policy.ts";

describe("incremental subagent waits", () => {
	test("returns only undelivered settled records", () => {
		const consumed = { id: "consumed", state: "cold", deliveryConsumed: true };
		const fresh = { id: "fresh", state: "cold", deliveryConsumed: false };
		const running = { id: "running", state: "running", deliveryConsumed: false };

		const result = incrementalWaitState([consumed, fresh, running]);

		expect(result.settled.map((record) => record.id)).toEqual(["fresh"]);
		expect(result.pending.map((record) => record.id)).toEqual(["running"]);
	});

	test("does not report consumed records as pending", () => {
		const result = incrementalWaitState([
			{ id: "done", state: "cold", deliveryConsumed: true },
		]);

		expect(result).toEqual({ settled: [], pending: [] });
	});
});
