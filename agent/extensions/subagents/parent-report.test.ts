import { describe, expect, test } from "bun:test";
import {
	MAX_PARENT_REPORTS_PER_DELIVERY,
	parentReportEvent,
	parentReportNotification,
	parseParentReportEvent,
	takeParentReportBatch,
} from "./parent-report.ts";

describe("subagent parent reports", () => {
	test("round-trips a valid report", () => {
		const event = parentReportEvent({ message: "Shared header needs a coordinator decision.", delivery: "steer" });
		expect(parseParentReportEvent(event)).toEqual({
			message: "Shared header needs a coordinator decision.",
			delivery: "steer",
		});
	});

	test("reads a report from an RPC notification", () => {
		expect(parseParentReportEvent({
			type: "extension_ui_request",
			method: "notify",
			message: parentReportNotification({ message: "Need a decision.", delivery: "follow_up" }),
		})).toEqual({ message: "Need a decision.", delivery: "follow_up" });
	});

	test("rejects empty messages and unknown delivery modes", () => {
		expect(parseParentReportEvent(parentReportEvent({ message: "  ", delivery: "follow_up" }))).toBeUndefined();
		expect(parseParentReportEvent({
			type: "managed_subagent_parent_report",
			message: "Blocked",
			delivery: "immediate",
		})).toBeUndefined();
	});

	test("takes no more than three pending reports", () => {
		const pending = ["one", "two", "three", "four"].map((message) => ({ message, delivery: "follow_up" as const }));
		expect(MAX_PARENT_REPORTS_PER_DELIVERY).toBe(3);
		expect(takeParentReportBatch(pending, "idle").map((report) => report.message)).toEqual(["one", "two", "three"]);
		expect(pending.map((report) => report.message)).toEqual(["four"]);
	});

	test("increases the batch limit as the pending queue grows", () => {
		for (const [queued, expected] of [[6, 3], [7, 4], [9, 4], [10, 5], [11, 5], [12, 6]] as const) {
			const pending = Array.from({ length: queued }, (_, index) => ({ message: String(index), delivery: "follow_up" as const }));
			expect(takeParentReportBatch(pending, "idle")).toHaveLength(expected);
			expect(pending).toHaveLength(queued - expected);
		}
	});

	test("takes only steering reports at a turn boundary", () => {
		const pending = [
			{ message: "later", delivery: "follow_up" as const },
			{ message: "now one", delivery: "steer" as const },
			{ message: "now two", delivery: "steer" as const },
		];
		expect(takeParentReportBatch(pending, "turn_end").map((report) => report.message)).toEqual(["now one", "now two"]);
		expect(pending.map((report) => report.message)).toEqual(["later"]);
	});

	test("takes all delivery modes after an agent run", () => {
		const pending = [
			{ message: "one", delivery: "follow_up" as const },
			{ message: "two", delivery: "steer" as const },
		];
		expect(takeParentReportBatch(pending, "agent_end")).toEqual([
			{ message: "one", delivery: "follow_up" },
			{ message: "two", delivery: "steer" },
		]);
		expect(pending).toEqual([]);
	});
});
