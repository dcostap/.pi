export const TODO_STATUS_EVENT = "todo:status";
export const TODO_STATE_ENTRY = "todo-state-v1";

export type TodoStatus = {
	current?: {
		id: string;
		text: string;
	};
	completed: number;
	total: number;
};

export type TodoStatusEvent = {
	status?: TodoStatus;
};

export function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const status = value as Record<string, unknown>;
	if (!Number.isInteger(status.completed) || !Number.isInteger(status.total)) return undefined;
	if ((status.completed as number) < 0 || (status.total as number) <= 0 || (status.completed as number) > (status.total as number)) return undefined;
	if (status.current === undefined) return { completed: status.completed as number, total: status.total as number };
	if (!status.current || typeof status.current !== "object" || Array.isArray(status.current)) return undefined;
	const current = status.current as Record<string, unknown>;
	if (typeof current.id !== "string" || !current.id.trim() || typeof current.text !== "string" || !current.text.trim()) return undefined;
	return {
		current: { id: current.id.trim(), text: current.text.trim() },
		completed: status.completed as number,
		total: status.total as number,
	};
}

export function formatTodoStatus(status: TodoStatus): string {
	return `${formatTodoTask(status)} ${formatTodoProgress(status)}`;
}

export function formatTodoTask(status: TodoStatus): string {
	return status.current ? `○ ${status.current.id} ${status.current.text}` : "○ no current";
}

export function formatTodoProgress(status: TodoStatus): string {
	return status.current
		? `${Math.min(status.completed + 1, status.total)}/${status.total}`
		: `${status.completed}/${status.total}`;
}
