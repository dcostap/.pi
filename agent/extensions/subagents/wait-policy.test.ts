import { describe, expect, test } from "bun:test";
import { implicitAnyWaitCandidates, incrementalWaitState } from "./wait-policy.ts";

describe("implicit any waits", () => {
	test("selects active records and pending deliveries", () => {
		const records = [
			{ id: "queued", state: "queued", deliveryPending: false, deliveryConsumed: false },
			{ id: "running", state: "running", deliveryPending: false, deliveryConsumed: false },
			{ id: "fresh", state: "cold", deliveryPending: true, deliveryConsumed: false },
			{ id: "historical", state: "cold", deliveryPending: false, deliveryConsumed: false },
			{ id: "stopping-consumed", state: "stopping", deliveryPending: false, deliveryConsumed: true },
			{ id: "consumed", state: "cold", deliveryPending: true, deliveryConsumed: true },
		];

		expect(implicitAnyWaitCandidates(records).map((record) => record.id)).toEqual(["queued", "running", "fresh"]);
	});
});

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
