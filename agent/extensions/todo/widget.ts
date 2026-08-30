import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatRemaining } from "./duration.ts";
import type { TodoScheduler } from "./scheduler.ts";
import { getCurrentTaskId } from "./state.ts";
import type { TodoItem, TodoState } from "./types.ts";

const MAX_ITEM_ROWS = 12;

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
	const header = theme.fg("toolTitle", theme.bold("Todos"))
		+ theme.fg("muted", ` · ${done.length}/${tasks.length} done · ${watches.length} watch${watches.length === 1 ? "" : "es"} · /todo to inspect`);

	const preferred = [
		...state.items.filter((item) => item.kind === "task" && !item.done),
		...state.items.filter((item) => item.kind === "watch"),
		...state.items.filter((item) => item.kind === "task" && item.done).slice(-2),
	];
	const visible = preferred.slice(0, MAX_ITEM_ROWS);
	const lines = [header];
	const currentTaskId = getCurrentTaskId(state);
	let lastGroup: string | undefined | null = null;
	for (const item of visible) {
		if (item.group && item.group !== lastGroup) lines.push(theme.fg("accent", `  ${item.group}`));
		lastGroup = item.group;
		lines.push(renderItem(item, item.id === currentTaskId, theme, nextDue(item.id), now));
	}
	if (state.items.length === 0) lines.push(theme.fg("dim", "  No items. The agent or /todo can add one."));
	const omitted = preferred.length - visible.length;
	if (omitted > 0) lines.push(theme.fg("dim", `  … ${omitted} more item${omitted === 1 ? "" : "s"}`));
	if (!state.scriptsEnabled && watches.some((item) => item.schedule?.action === "command")) {
		lines.push(theme.fg("warning", "  Automatic watch commands are disabled."));
	}
	return lines;
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
	const connector = theme.fg("dim", "  ├─ ");
	const marker = item.kind === "watch"
		? watchMarker(item, theme)
		: item.done
			? theme.fg("success", "✓")
			: theme.fg("dim", "○");
	const text = item.done ? theme.fg("dim", theme.strikethrough(item.text)) : theme.fg("muted", item.text);
	const id = theme.fg("accent", item.id);
	const due = dueAt === undefined ? "" : theme.fg("dim", ` · ${formatRemaining(dueAt - now)}`);
	const run = item.lastRun
		? theme.fg(item.lastRun.status === "success" ? "success" : item.lastRun.status === "failed" ? "error" : "warning", ` · ${item.lastRun.status}`)
		: "";
	const currentLabel = current ? theme.fg("accent", " · CURRENT") : "";
	return `${connector}${marker} ${id} ${text}${due}${run}${currentLabel}`;
}

function watchMarker(item: TodoItem, theme: Theme): string {
	if (item.lastRun?.status === "failed") return theme.fg("error", "◆");
	if (item.lastRun?.status === "success") return theme.fg("success", "◆");
	return theme.fg("accent", "◆");
}
