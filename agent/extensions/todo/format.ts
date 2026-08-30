import { formatElapsed } from "./duration.ts";
import { getCurrentTaskId } from "./state.ts";
import type { TodoItem, TodoRunSummary, TodoState } from "./types.ts";

export function formatTodoState(state: TodoState): string {
	const open = state.items.filter((item) => item.kind === "task" && !item.done).length;
	const done = state.items.filter((item) => item.kind === "task" && item.done).length;
	const watches = state.items.filter((item) => item.kind === "watch").length;
	const lines = [
		`Todo list · ${open} open · ${done} completed · ${watches} watches · scripts ${state.scriptsEnabled ? "on" : "off"}`,
	];
	if (state.items.length === 0) return `${lines[0]}\n\nNo todo items.`;
	const currentTaskId = getCurrentTaskId(state);
	let group: string | undefined | null = null;
	for (const item of state.items) {
		if (item.group !== group) {
			group = item.group;
			if (group) lines.push("", `${group}:`);
		}
		lines.push(formatItem(item, item.id === currentTaskId));
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
