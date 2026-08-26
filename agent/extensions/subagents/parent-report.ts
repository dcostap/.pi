export const PARENT_REPORT_EVENT_TYPE = "managed_subagent_parent_report";

export const PARENT_REPORT_DELIVERIES = ["steer", "follow_up"] as const;

export const MAX_PARENT_REPORTS_PER_DELIVERY = 3;

export type ParentReportDelivery = (typeof PARENT_REPORT_DELIVERIES)[number];

export type ParentReport = {
	message: string;
	delivery: ParentReportDelivery;
};

export type ParentReportDeliveryOpportunity = "turn_end" | "agent_end" | "idle";

/**
 * Remove one delivery batch from a pending report queue.
 * A turn boundary can accept steering reports only. Later boundaries can
 * accept every report while keeping the original order.
 */
export function takeParentReportBatch<T extends ParentReport>(
	pending: T[],
	opportunity: ParentReportDeliveryOpportunity,
	limit = MAX_PARENT_REPORTS_PER_DELIVERY,
): T[] {
	if (limit <= 0) return [];
	const batch: T[] = [];
	for (let index = 0; index < pending.length && batch.length < limit;) {
		const report = pending[index]!;
		if (opportunity === "turn_end" && report.delivery !== "steer") {
			index++;
			continue;
		}
		batch.push(report);
		pending.splice(index, 1);
	}
	return batch;
}

export function parentReportEvent(report: ParentReport): { type: typeof PARENT_REPORT_EVENT_TYPE } & ParentReport {
	return { type: PARENT_REPORT_EVENT_TYPE, ...report };
}

export function parseParentReportEvent(value: unknown): ParentReport | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let event = value as Record<string, unknown>;
	if (event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string") {
		try {
			const parsed = JSON.parse(event.message);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			event = parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	if (event.type !== PARENT_REPORT_EVENT_TYPE || typeof event.message !== "string" || !event.message.trim()) return undefined;
	if (event.delivery !== "steer" && event.delivery !== "follow_up") return undefined;
	return { message: event.message, delivery: event.delivery };
}

export function parentReportNotification(report: ParentReport): string {
	return JSON.stringify(parentReportEvent(report));
}
