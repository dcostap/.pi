import type { CompletionSnapshot } from "./completion.ts";
import type { ParentCompletionGroupUpdate, ParentUpdate } from "./parent-events.ts";

export type CompletionTarget = {
	id: string;
	runId: string;
	completion?: CompletionSnapshot;
};

export type CompletionNotification = {
	id: string;
	label: string;
	targets: CompletionTarget[];
	createdAt: number;
	state: "collecting" | "queued";
};

export class CompletionNotificationCoordinator {
	private current?: CompletionNotification;

	get active(): CompletionNotification | undefined {
		return this.current;
	}

	arm(notification: CompletionNotification): void {
		if (this.current) throw new Error(`Completion notification ${this.current.id} is still active`);
		this.current = notification;
	}

	queueIfReady(): ParentCompletionGroupUpdate | undefined {
		const notification = this.current;
		if (!notification || notification.state === "queued") return undefined;
		if (!notification.targets.every((target) => target.completion)) return undefined;
		notification.state = "queued";
		return {
			kind: "completion_group",
			notificationId: notification.id,
			createdAt: Date.now(),
			label: notification.label,
			completions: notification.targets.map((target) => target.completion!),
		};
	}

	markDelivered(updates: ParentUpdate[]): void {
		const notification = this.current;
		if (!notification || notification.state !== "queued") return;
		if (updates.some((update) => update.kind === "completion_group" && update.notificationId === notification.id)) {
			this.current = undefined;
		}
	}

	clear(): void {
		this.current = undefined;
	}
}
