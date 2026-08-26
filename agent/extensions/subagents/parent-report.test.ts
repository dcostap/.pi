import { describe, expect, test } from "bun:test";
import { parentReportEvent, parentReportNotification, parseParentReportEvent } from "./parent-report.ts";

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
});
