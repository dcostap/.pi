import { describe, expect, test } from "bun:test";
import {
	childReportNotification,
	childRuntimeNotification,
	childTodoNotification,
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
		expect(parseManagedChildEvent({
			type: "extension_ui_request",
			method: "notify",
			message: childTodoNotification({ current: { id: "t-44", text: "Review include/panel" }, completed: 2, total: 10 }),
		})).toMatchObject({
			kind: "todo",
			status: { current: { id: "t-44", text: "Review include/panel" }, completed: 2, total: 10 },
		});
		expect(parseManagedChildEvent({
			type: "extension_ui_request",
			method: "notify",
			message: childTodoNotification(undefined),
		})).toMatchObject({ kind: "todo", status: null });
	});

	test("rejects invalid events", () => {
		expect(parseManagedChildEvent({ type: "other" })).toBeUndefined();
		expect(parseManagedChildEvent({ type: "managed_subagent_child_event", kind: "report", message: " " })).toBeUndefined();
		expect(parseManagedChildEvent({ type: "managed_subagent_child_event", kind: "todo", status: { completed: 4, total: 3 } })).toBeUndefined();
	});
});
