import { describe, expect, test } from "bun:test";
import {
	childReportNotification,
	childRuntimeNotification,
	parseManagedChildEvent,
} from "./child-protocol.ts";

describe("managed child protocol", () => {
	test("reads report and runtime events through RPC notifications", () => {
		expect(parseManagedChildEvent({
			type: "extension_ui_request",
			method: "notify",
			message: childReportNotification("Need a decision."),
		})).toMatchObject({ kind: "report", message: "Need a decision." });
		expect(parseManagedChildEvent({
			type: "extension_ui_request",
			method: "notify",
			message: childRuntimeNotification(true),
		})).toMatchObject({ kind: "runtime", pendingWork: true });
	});

	test("rejects invalid events", () => {
		expect(parseManagedChildEvent({ type: "other" })).toBeUndefined();
		expect(parseManagedChildEvent({ type: "managed_subagent_child_event", kind: "report", message: " " })).toBeUndefined();
	});
});
