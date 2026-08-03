import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAlignedTable, type AlignedColumn } from "../../_shared/aligned-table.ts";
import { cleanInline, formatDuration } from "../formatting.ts";
import type { BackgroundProcessSnapshot } from "../manager.ts";

const MAX_WIDGET_ROWS = 8;

type ProcessWidgetRow = {
	connector: string;
	state: string;
	id: string;
	title: string;
	duration: string;
	outputSize: string;
	activity: string;
};

// Keep identity and current activity visible. Duration and captured size are
// lower-priority metrics and disappear before useful text on narrow terminals.
const PROCESS_COLUMNS: readonly AlignedColumn<keyof ProcessWidgetRow>[] = [
	{ key: "connector", minWidth: 3 },
	{ key: "state", minWidth: 10 },
	{ key: "id", minWidth: 8 },
	{ key: "title", minWidth: 12, maxWidth: 46, shrinkPriority: 2 },
	{ key: "duration", minWidth: 4, maxWidth: 10, align: "right", optional: true, hidePriority: 1 },
	{ key: "outputSize", minWidth: 5, maxWidth: 9, align: "right", optional: true, hidePriority: 2 },
	{ key: "activity", minWidth: 12, maxWidth: 80, shrinkPriority: 4 },
];

function stateText(snapshot: BackgroundProcessSnapshot, theme: Theme): string {
	if (snapshot.killRequested) return theme.fg("warning", "◐ stopping");
	return theme.fg("accent", "● running");
}

function latestActivity(snapshot: BackgroundProcessSnapshot): string {
	const outputLines = snapshot.output.text
		.split(/\r?\n/gu)
		.map(cleanInline)
		.filter(Boolean);
	const latest = outputLines.at(-1);
	if (latest) return latest;
	const command = cleanInline(snapshot.command);
	return command ? `$ ${command}` : "waiting for output";
}

export function processWidgetLines(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = Number.POSITIVE_INFINITY,
): string[] {
	const running = snapshots.filter((snapshot) => !snapshot.settled).slice(0, MAX_WIDGET_ROWS);
	if (running.length === 0) return [];

	const stopping = running.filter((snapshot) => snapshot.killRequested).length;
	const header = theme.fg("toolTitle", theme.bold("Background terminals"))
		+ theme.fg(
			"muted",
			` · ${running.length} running${stopping ? ` · ${stopping} stopping` : ""} · /ps to inspect`,
		);
	const rows = running.map((snapshot, index): ProcessWidgetRow => ({
		connector: theme.fg("dim", `${index === running.length - 1 ? "└─" : "├─"} `),
		state: stateText(snapshot, theme),
		id: theme.fg("accent", snapshot.id),
		title: theme.fg("muted", cleanInline(snapshot.title)),
		duration: theme.fg("dim", formatDuration(Math.max(0, now - snapshot.createdAt))),
		outputSize: snapshot.output.totalBytes > 0 ? theme.fg("dim", formatSize(snapshot.output.totalBytes)) : "",
		activity: theme.fg("muted", latestActivity(snapshot)),
	}));
	const rendered = renderAlignedTable(rows, width, PROCESS_COLUMNS, {
		gap: "  ",
		visibleWidth,
		truncate: (value, cellWidth) => truncateToWidth(value, cellWidth),
	});
	const omitted = snapshots.filter((snapshot) => !snapshot.settled).length - running.length;
	if (omitted > 0) rendered.push(theme.fg("dim", `… ${omitted} more running terminal${omitted === 1 ? "" : "s"}`));
	return [header, ...rendered];
}

export function processWidgetComponent(snapshots: readonly BackgroundProcessSnapshot[], theme: Theme) {
	return {
		render(width: number): string[] {
			const contentWidth = Math.max(0, width - 1);
			return processWidgetLines(snapshots, theme, Date.now(), contentWidth)
				.map((line) => truncateToWidth(` ${line}`, width));
		},
		invalidate() {},
	};
}
