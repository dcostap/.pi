import { formatElapsed } from "./duration.ts";
import { getCurrentTaskId, getRecentCompletedTasks } from "./state.ts";
import type { TodoItem, TodoRunSummary, TodoState } from "./types.ts";

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 60;
const ACTIVE_PAGE_BYTE_BUDGET = 32 * 1024;

export interface TodoFormatOptions {
	offset?: number;
	limit?: number;
}

export function formatTodoState(state: TodoState, options: TodoFormatOptions = {}): string {
	const open = state.items.filter((item) => item.kind === "task" && !item.done).length;
	const done = state.items.filter((item) => item.kind === "task" && item.done).length;
	const watches = state.items.filter((item) => item.kind === "watch").length;
	const active = state.items.filter((item) => item.kind === "watch" || !item.done);
	const offset = Math.min(active.length, Math.max(0, Math.floor(options.offset ?? 0)));
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE)));
	const lines = [
		`Todo list · ${open} open · ${done} completed · ${watches} watches · scripts ${state.scriptsEnabled ? "on" : "off"}`,
	];
	if (state.items.length === 0) return `${lines[0]}\n\nNo todo items.`;
	const currentTaskId = getCurrentTaskId(state);
	const currentTask = state.items.find((item) => item.id === currentTaskId);
	lines.push(currentTask ? `Current task: ${currentTask.id} · ${currentTask.text}` : "Current task: none");
	if (offset > 0) lines.push(`… ${offset} earlier active item${offset === 1 ? "" : "s"} omitted.`);
	const page = active.slice(offset, offset + limit);
	let group: string | undefined | null = null;
	let shown = 0;
	let activeBytes = 0;
	for (const item of page) {
		const itemLines: string[] = [];
		if (item.group !== group) {
			group = item.group;
			if (group) itemLines.push("", `${group}:`);
		}
		itemLines.push(formatItem(item, item.id === currentTaskId));
		const chunkBytes = Buffer.byteLength(itemLines.join("\n"), "utf8");
		if (shown > 0 && activeBytes + chunkBytes > ACTIVE_PAGE_BYTE_BUDGET) break;
		lines.push(...itemLines);
		activeBytes += chunkBytes;
		shown++;
	}
	const nextOffset = offset + shown;
	if (nextOffset < active.length) {
		lines.push("", `… ${active.length - nextOffset} more active item${active.length - nextOffset === 1 ? "" : "s"}. Use todo view with offset ${nextOffset}.`);
	}
	const recentCompleted = getRecentCompletedTasks(state);
	if (recentCompleted.length > 0) {
		lines.push("", `Recently completed (${recentCompleted.length} of ${done}):`);
		for (const item of recentCompleted) lines.push(formatItem(item));
	}
	return lines.join("\n");
}

export function formatRunResult(item: TodoItem, run: TodoRunSummary): string {
	const lines = [
		`Watch ${item.id} · ${item.text}`,
		`Status: ${run.status}${run.exitCode === undefined ? "" : ` · exit ${run.exitCode}`}${run.timedOut ? " · timed out" : ""} · ${formatElapsed(run.finishedAt - run.startedAt)}`,
	];
	if (item.schedule?.command) lines.push(`Command: ${item.schedule.command}`);
	if (item.schedule?.cwd) lines.push(`Directory: ${item.schedule.cwd}`);
	if (run.error) lines.push(`Error: ${run.error}`);
	if (run.output) lines.push("", "Output:", run.output);
	else lines.push("", "No output.");
	if (run.truncated) lines.push("", `Output was truncated.${run.fullOutputPath ? ` Full output: ${run.fullOutputPath}` : ""}`);
	return lines.join("\n");
}

export function formatReminder(item: TodoItem): string {
	return [
		`${item.kind === "task" ? "Todo reminder" : "Watch reminder"} · ${item.id}`,
		item.text,
		...(item.group ? [`Group: ${item.group}`] : []),
		`Repeats every ${item.schedule?.every} until ${item.kind === "task" ? "completed or disabled" : "disabled or removed"}.`,
	].join("\n");
}

export function formatTodoItemDetails(item: TodoItem): string {
	const lines = [
		`${item.kind === "task" ? "Task" : "Watch"} ${item.id}`,
		item.text,
		...(item.group ? [`Group: ${item.group}`] : []),
	];
	if (item.kind === "task") lines.push(`State: ${item.done ? "completed" : "open"}`);
	if (item.schedule) {
		lines.push(`Schedule: ${item.schedule.enabled ? "enabled" : "disabled"} · ${item.schedule.action} every ${item.schedule.every}`);
		if (item.schedule.command) lines.push(`Command: ${item.schedule.command}`);
		if (item.schedule.cwd) lines.push(`Directory: ${item.schedule.cwd}`);
		if (item.schedule.timeoutSeconds) lines.push(`Timeout: ${item.schedule.timeoutSeconds}s`);
	}
	if (item.lastRun) lines.push("", formatRunResult(item, item.lastRun));
	return lines.join("\n");
}

function formatItem(item: TodoItem, current = false): string {
	const marker = item.kind === "watch" ? "◆" : item.done ? "[x]" : "[ ]";
	const group = item.group ? ` [${item.group}]` : "";
	const schedule = item.schedule?.enabled
		? item.schedule.action === "command"
			? ` · every ${item.schedule.every} command`
			: ` · remind every ${item.schedule.every}`
		: "";
	return `${marker} ${item.id}${group} ${item.text}${schedule}${current ? " · CURRENT" : ""}`;
}
