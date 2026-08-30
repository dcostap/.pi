export type TodoItemKind = "task" | "watch";
export type TodoScheduleAction = "remind" | "command";

export interface TodoSchedule {
	enabled: boolean;
	every: string;
	intervalMs: number;
	action: TodoScheduleAction;
	command?: string;
	cwd?: string;
	timeoutSeconds?: number;
	lastTriggeredAt?: number;
}

export interface TodoRunSummary {
	startedAt: number;
	finishedAt: number;
	status: "success" | "failed" | "cancelled";
	exitCode?: number | null;
	timedOut?: boolean;
	output: string;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
	fullOutputPath?: string;
	error?: string;
}

export interface TodoItem {
	id: string;
	kind: TodoItemKind;
	text: string;
	group?: string;
	done?: boolean;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	schedule?: TodoSchedule;
	lastRun?: TodoRunSummary;
}

export interface TodoState {
	version: 1;
	enabled: boolean;
	scriptsEnabled: boolean;
	nextSequence: number;
	items: TodoItem[];
}

export interface TodoChange {
	action:
		| "add"
		| "edit"
		| "complete"
		| "reopen"
		| "remove"
		| "move"
		| "set_schedule"
		| "disable_schedule"
		| "rename_group";
	id?: string;
	kind?: TodoItemKind;
	text?: string;
	group?: string;
	clear_group?: boolean;
	before_id?: string;
	new_group?: string;
	every?: string;
	schedule_action?: TodoScheduleAction;
	command?: string;
	cwd?: string;
	timeout_seconds?: number;
}

export interface TodoToolInput {
	op: "view" | "apply" | "run";
	changes?: TodoChange[];
	id?: string;
}

export interface ScheduledTodoItem {
	item: TodoItem;
	dueAt: number;
}
