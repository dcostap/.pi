import { describe, expect, test } from "bun:test";
import { CompletionNotificationCoordinator, type CompletionNotification } from "./completion-notification.ts";

function completion(id: string) {
	return {
		id,
		title: id,
		outcome: "completed" as const,
		model: "p/m",
		thinking: "high" as const,
		task: "Task",
		activity: "done",
		createdAt: 1,
		settledAt: 2,
		attempts: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		finalAnswer: "Done",
		sessionFile: "session.jsonl",
	};
}

function notification(id: string): CompletionNotification {
	return {
		id,
		label: id,
		createdAt: 1,
		state: "collecting",
		targets: [{ id: "sa-one", runId: "sa-one-r1", completion: completion("sa-one") }],
	};
}

describe("all-complete notification delivery", () => {
	test("keeps a queued notification reserved until delivery succeeds", () => {
		const coordinator = new CompletionNotificationCoordinator();
		coordinator.arm(notification("notify-one"));
		const update = coordinator.queueIfReady();

		expect(update?.notificationId).toBe("notify-one");
		expect(coordinator.active?.state).toBe("queued");
		expect(() => coordinator.arm(notification("notify-two"))).toThrow("still active");

		coordinator.markDelivered([update!]);
		expect(coordinator.active).toBeUndefined();
		expect(() => coordinator.arm(notification("notify-two"))).not.toThrow();
	});

	test("does not release a notification for another delivery", () => {
		const coordinator = new CompletionNotificationCoordinator();
		coordinator.arm(notification("notify-one"));
		coordinator.queueIfReady();

		coordinator.markDelivered([]);

		expect(coordinator.active?.id).toBe("notify-one");
	});
});
