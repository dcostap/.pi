import { normalizeTodoStatus, type TodoStatus } from "../_shared/todo-status.ts";

export const MANAGED_CHILD_EVENT_TYPE = "managed_subagent_child_event";

export type ChildReportEvent = {
	type: typeof MANAGED_CHILD_EVENT_TYPE;
	kind: "report";
	message: string;
};

export type ChildRuntimeEvent = {
	type: typeof MANAGED_CHILD_EVENT_TYPE;
	kind: "runtime";
	pendingWork: boolean;
};

export type ChildTodoEvent = {
	type: typeof MANAGED_CHILD_EVENT_TYPE;
	kind: "todo";
	status: TodoStatus | null;
};

export type ManagedChildEvent = ChildReportEvent | ChildRuntimeEvent | ChildTodoEvent;

export function childReportNotification(message: string): string {
	return JSON.stringify({ type: MANAGED_CHILD_EVENT_TYPE, kind: "report", message } satisfies ChildReportEvent);
}

export function childRuntimeNotification(pendingWork: boolean): string {
	return JSON.stringify({ type: MANAGED_CHILD_EVENT_TYPE, kind: "runtime", pendingWork } satisfies ChildRuntimeEvent);
}

export function childTodoNotification(status: TodoStatus | undefined): string {
	return JSON.stringify({ type: MANAGED_CHILD_EVENT_TYPE, kind: "todo", status: status ?? null } satisfies ChildTodoEvent);
}

export function parseManagedChildEvent(value: unknown): ManagedChildEvent | undefined {
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
	if (event.type !== MANAGED_CHILD_EVENT_TYPE) return undefined;
	if (event.kind === "report" && typeof event.message === "string" && event.message.trim()) {
		return { type: MANAGED_CHILD_EVENT_TYPE, kind: "report", message: event.message.trim() };
	}
	if (event.kind === "runtime" && typeof event.pendingWork === "boolean") {
		return { type: MANAGED_CHILD_EVENT_TYPE, kind: "runtime", pendingWork: event.pendingWork };
	}
	if (event.kind === "todo") {
		if (event.status === null) return { type: MANAGED_CHILD_EVENT_TYPE, kind: "todo", status: null };
		const status = normalizeTodoStatus(event.status);
		if (status) return { type: MANAGED_CHILD_EVENT_TYPE, kind: "todo", status };
	}
	return undefined;
}
