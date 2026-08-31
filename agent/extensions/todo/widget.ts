import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatRemaining } from "./duration.ts";
import type { TodoScheduler } from "./scheduler.ts";
import { getCurrentTaskId } from "./state.ts";
import type { TodoItem, TodoState } from "./types.ts";

const COMPLETED_VISIBILITY_MS = 60_000;
const MAX_ITEM_ROWS = 5;

export function todoWidgetLines(
	state: TodoState,
	theme: Theme,
	nextDue: (id: string) => number | undefined,
	now = Date.now(),
): string[] {
	const tasks = state.items.filter((item) => item.kind === "task");
	const open = tasks.filter((item) => !item.done);
	const done = tasks.filter((item) => item.done);
	const watches = state.items.filter((item) => item.kind === "watch");
	const currentTaskId = getCurrentTaskId(state);
	const current = open.find((item) => item.id === currentTaskId);
	const watchAlerts = watches.filter((item) => item.lastRun?.status === "failed");
	const recentCompleted = done
		.filter((item) => now - (item.completedAt ?? item.updatedAt) < COMPLETED_VISIBILITY_MS)
		.sort((left, right) => (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt));

	const header = renderHeader(tasks.length, open.length, done.length, watches.length, currentTaskId, theme);
	if (state.items.length === 0) {
		return [header, theme.fg("dim", "  No items. The agent or /todo can add one.")];
	}

	const remainingOpen = open.filter((item) => item.id !== currentTaskId);
	const activeRanked = [
		...(current ? [{ item: current, current: true }] : []),
		...watchAlerts.map((item) => ({ item, current: false })),
		...remainingOpen.map((item) => ({ item, current: false })),
	];
	const reservedCompletedRows = Math.min(2, recentCompleted.length, MAX_ITEM_ROWS);
	const activeRows = Math.min(activeRanked.length, MAX_ITEM_ROWS - reservedCompletedRows);
	const completedRows = Math.min(recentCompleted.length, MAX_ITEM_ROWS - activeRows);
	const visible = [
		...activeRanked.slice(0, activeRows),
		...recentCompleted.slice(0, completedRows).map((item) => ({ item, current: false })),
	];
	const lines = [header];
	for (const entry of visible) {
		lines.push(renderItem(entry.item, entry.current, theme, nextDue(entry.item.id), now));
	}

	const hidden = activeRanked.length + recentCompleted.length - visible.length;
	if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} more relevant item${hidden === 1 ? "" : "s"}`));
	if (!state.scriptsEnabled && watches.some((item) => item.schedule?.action === "command")) {
		lines.push(theme.fg("warning", "  Automatic watch commands are disabled."));
	}
	return lines;
}

function renderHeader(
	total: number,
	open: number,
	done: number,
	watches: number,
	currentTaskId: string | undefined,
	theme: Theme,
): string {
	const title = theme.fg("toolTitle", theme.bold("Todos"));
	if (total > 0 && open === 0) {
		return title + theme.fg("muted", ` · ✓ ${done}/${total} complete${watches ? ` · ${watches} watch${watches === 1 ? "" : "es"}` : ""} · /todo for history`);
	}
	const taskStatus = total > 0 ? ` · ${open} open · ${done} done` : "";
	const watchStatus = watches ? ` · ${watches} watch${watches === 1 ? "" : "es"}` : "";
	const currentStatus = open > 0 && !currentTaskId ? " · no current task" : "";
	return title + theme.fg("muted", `${taskStatus}${watchStatus}${currentStatus} · /todo`);
}

export function todoWidgetComponent(state: TodoState, theme: Theme, scheduler: TodoScheduler, requestRender: () => void) {
	const timer = setInterval(requestRender, 1000);
	return {
		render(width: number): string[] {
			return todoWidgetLines(state, theme, (id) => scheduler.nextDue(id), Date.now())
				.map((line) => truncateToWidth(` ${line}`, width, "…"));
		},
		invalidate() {},
		dispose() { clearInterval(timer); },
	};
}

function renderItem(item: TodoItem, current: boolean, theme: Theme, dueAt: number | undefined, now: number): string {
	const connector = theme.fg("dim", "  ");
	const marker = current
		? theme.fg("accent", "▶")
		: item.kind === "watch"
			? watchMarker(item, theme)
			: item.done
				? theme.fg("success", "✓")
				: theme.fg("dim", "○");
	const text = item.done
		? theme.fg("dim", theme.strikethrough(item.text))
		: theme.fg(current ? "text" : "muted", item.text);
	const id = theme.fg("accent", item.id);
	const group = item.group ? theme.fg("dim", ` · ${item.group}`) : "";
	const due = dueAt === undefined ? "" : theme.fg("dim", ` · ${formatRemaining(dueAt - now)}`);
	const run = item.lastRun
		? theme.fg(item.lastRun.status === "success" ? "success" : item.lastRun.status === "failed" ? "error" : "warning", ` · ${item.lastRun.status}`)
		: "";
	return `${connector}${marker} ${id} ${text}${group}${due}${run}`;
}

function watchMarker(item: TodoItem, theme: Theme): string {
	if (item.lastRun?.status === "failed") return theme.fg("error", "◆");
	if (item.lastRun?.status === "success") return theme.fg("success", "◆");
	return theme.fg("accent", "◆");
}
