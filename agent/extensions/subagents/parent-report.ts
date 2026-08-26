export const PARENT_REPORT_EVENT_TYPE = "managed_subagent_parent_report";

export const PARENT_REPORT_DELIVERIES = ["steer", "follow_up"] as const;

export type ParentReportDelivery = (typeof PARENT_REPORT_DELIVERIES)[number];

export type ParentReport = {
	message: string;
	delivery: ParentReportDelivery;
};

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
