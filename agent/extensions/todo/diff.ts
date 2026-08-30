import type { TodoChange, TodoItem, TodoState } from "./types.ts";

export type TodoDiffLineKind = "add" | "remove" | "move" | "note";

export interface TodoDiffLine {
	kind: TodoDiffLineKind;
	text: string;
}

const MAX_DIFF_LINES = 100;
const MAX_DIFF_TEXT = 240;

export function buildTodoDiff(before: TodoState, after: TodoState, changes: readonly TodoChange[]): TodoDiffLine[] {
	const lines: TodoDiffLine[] = [];
	const beforeCurrent = currentTask(before);
	const afterCurrent = currentTask(after);
	if (beforeCurrent?.id !== afterCurrent?.id) {
		if (beforeCurrent) lines.push({ kind: "remove", text: formatCurrent(beforeCurrent) });
		if (afterCurrent) lines.push({ kind: "add", text: formatCurrent(afterCurrent) });
	}

	const beforeById = new Map(before.items.map((item) => [item.id, item]));
	const afterById = new Map(after.items.map((item) => [item.id, item]));
	for (const item of before.items) {
		const updated = afterById.get(item.id);
		if (!updated) {
			lines.push({ kind: "remove", text: formatDiffItem(item) });
			continue;
		}
		if (itemSignature(item) !== itemSignature(updated)) {
			lines.push({ kind: "remove", text: formatDiffItem(item) });
			lines.push({ kind: "add", text: formatDiffItem(updated) });
		}
	}
	for (const item of after.items) {
		if (!beforeById.has(item.id)) lines.push({ kind: "add", text: formatDiffItem(item) });
	}

	for (const change of changes) {
		if (change.action !== "move" || !change.id) continue;
		const beforeIndex = before.items.findIndex((item) => item.id === change.id);
		const afterIndex = after.items.findIndex((item) => item.id === change.id);
		if (beforeIndex === afterIndex) continue;
		lines.push({
			kind: "move",
			text: change.before_id ? `moved ${change.id} before ${change.before_id}` : `moved ${change.id} to the end`,
		});
	}

	if (lines.length === 0) return [{ kind: "note", text: "No visible todo changes." }];
	if (lines.length <= MAX_DIFF_LINES) return lines;
	return [
		...lines.slice(0, MAX_DIFF_LINES),
		{ kind: "note", text: `… ${lines.length - MAX_DIFF_LINES} more diff lines omitted` },
	];
}

function currentTask(state: TodoState): TodoItem | undefined {
	const item = state.items.find((candidate) => candidate.id === state.currentTaskId);
	return item?.kind === "task" && !item.done ? item : undefined;
}

function formatCurrent(item: TodoItem): string {
	return compact(`CURRENT ${item.id} · ${item.text}`);
}

function formatDiffItem(item: TodoItem): string {
	const marker = item.kind === "watch" ? "◆" : item.done ? "[x]" : "[ ]";
	const group = item.group ? ` [${item.group}]` : "";
	let schedule = "";
	if (item.schedule) {
		schedule = item.schedule.enabled
			? ` · ${item.schedule.action} every ${item.schedule.every}`
			: ` · ${item.schedule.action} disabled`;
		if (item.schedule.action === "command" && item.schedule.command) schedule += ` · ${item.schedule.command}`;
	}
	return compact(`${marker} ${item.id}${group} ${item.text}${schedule}`);
}

function itemSignature(item: TodoItem): string {
	return JSON.stringify({
		kind: item.kind,
		text: item.text,
		group: item.group,
		done: item.done,
		schedule: item.schedule && {
			enabled: item.schedule.enabled,
			every: item.schedule.every,
			action: item.schedule.action,
			command: item.schedule.command,
			cwd: item.schedule.cwd,
			timeoutSeconds: item.schedule.timeoutSeconds,
		},
	});
}

function compact(value: string): string {
	const line = value.replace(/\s+/gu, " ").trim();
	return line.length <= MAX_DIFF_TEXT ? line : `${line.slice(0, MAX_DIFF_TEXT - 1)}…`;
}
