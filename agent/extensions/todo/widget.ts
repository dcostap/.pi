import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatRemaining } from "./duration.ts";
import type { TodoScheduler } from "./scheduler.ts";
import { getCurrentTaskId, getRecentCompletedTasks } from "./state.ts";
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
	const currentTaskId = getCurrentTaskId(state);
	const header = theme.fg("toolTitle", theme.bold("Todos"))
		+ theme.fg("muted", ` · ${done.length}/${tasks.length} done · ${watches.length} watch${watches.length === 1 ? "" : "es"} · current ${currentTaskId ?? "none"} · /todo to inspect`);

	const active = [
		...state.items.filter((item) => item.kind === "task" && !item.done),
		...state.items.filter((item) => item.kind === "watch"),
	];
	const recentCompleted = getRecentCompletedTasks(state);
	const visibleActive = active.slice(0, Math.max(0, MAX_ITEM_ROWS - recentCompleted.length));
	const groups = groupVisibleItems(visibleActive, recentCompleted);
	const completedByGroup = countCompletedByGroup(state);
	const lines = [header];
	for (const group of groups) {
		if (group.name) lines.push(theme.fg("accent", `  ${group.name}`));
		for (const item of [...group.active, ...group.completed]) {
			lines.push(renderItem(item, item.id === currentTaskId, theme, nextDue(item.id), now));
		}
		const hiddenCompleted = (completedByGroup.get(group.name) ?? 0) - group.completed.length;
		if (hiddenCompleted > 0) {
			lines.push(theme.fg("dim", `  … ${hiddenCompleted} ${hiddenCompleted === 1 ? "other" : "others"} completed`));
		}
	}
	if (state.items.length === 0) lines.push(theme.fg("dim", "  No items. The agent or /todo can add one."));
	const hiddenActive = active.length - visibleActive.length;
	if (hiddenActive > 0) lines.push(theme.fg("dim", `  … ${hiddenActive} more active item${hiddenActive === 1 ? "" : "s"}`));
	const renderedGroups = new Set(groups.map((group) => group.name));
	const completedInOtherGroups = [...completedByGroup]
		.filter(([group]) => !renderedGroups.has(group))
		.reduce((total, [, count]) => total + count, 0);
	if (completedInOtherGroups > 0) {
		lines.push(theme.fg("dim", `  … ${completedInOtherGroups} completed item${completedInOtherGroups === 1 ? "" : "s"} in other groups`));
	}
	if (!state.scriptsEnabled && watches.some((item) => item.schedule?.action === "command")) {
		lines.push(theme.fg("warning", "  Automatic watch commands are disabled."));
	}
	return lines;
}

interface VisibleGroup {
	name?: string;
	active: TodoItem[];
	completed: TodoItem[];
}

function groupVisibleItems(active: TodoItem[], completed: TodoItem[]): VisibleGroup[] {
	const groups = new Map<string | undefined, VisibleGroup>();
	for (const [items, key] of [[active, "active"], [completed, "completed"]] as const) {
		for (const item of items) {
			let group = groups.get(item.group);
			if (!group) {
				group = { name: item.group, active: [], completed: [] };
				groups.set(item.group, group);
			}
			group[key].push(item);
		}
	}
	return [...groups.values()];
}

function countCompletedByGroup(state: TodoState): Map<string | undefined, number> {
	const counts = new Map<string | undefined, number>();
	for (const item of state.items) {
		if (item.kind !== "task" || !item.done) continue;
		counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
	}
	return counts;
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
