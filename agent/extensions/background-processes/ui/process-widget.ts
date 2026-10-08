import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { renderAlignedTable, type AlignedColumn } from "../../_shared/aligned-table.ts";
import { createSpinnerTicker, spinnerFrame } from "../../_shared/spinner.ts";
import { cleanInline, formatDuration } from "../formatting.ts";
import type { BackgroundProcessSnapshot } from "../manager.ts";

const MAX_WIDGET_ROWS = 5;

type ProcessWidgetRow = {
	state: string;
	id: string;
	title: string;
	duration: string;
	activity: string;
};

// Identity first; the latest output line takes whatever width is left.
const PROCESS_COLUMNS: readonly AlignedColumn<keyof ProcessWidgetRow>[] = [
	{ key: "state", minWidth: 1 },
	{ key: "id", minWidth: 4 },
	{ key: "title", minWidth: 8, maxWidth: 40, shrinkPriority: 2 },
	{ key: "duration", minWidth: 3, maxWidth: 8, align: "right", optional: true, hidePriority: 1 },
	{ key: "activity", minWidth: 8, maxWidth: 100, shrinkPriority: 4, optional: true, hidePriority: 2 },
];

function latestActivity(snapshot: BackgroundProcessSnapshot): string {
	if (snapshot.killRequested) return "stopping…";
	const latest = snapshot.output.text
		.split(/\r?\n/gu)
		.map(cleanInline)
		.filter(Boolean)
		.at(-1);
	return latest ?? `$ ${cleanInline(snapshot.command)}`;
}

export function processWidgetLines(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = Number.POSITIVE_INFINITY,
): string[] {
	const allRunning = snapshots.filter((snapshot) => !snapshot.settled);
	if (allRunning.length === 0) return [];
	const running = allRunning.slice(-MAX_WIDGET_ROWS);

	const rows = running.map((snapshot): ProcessWidgetRow => ({
		state: theme.fg(snapshot.killRequested ? "warning" : "accent", spinnerFrame(now)),
		id: theme.fg("accent", snapshot.id),
		title: theme.fg("toolOutput", cleanInline(snapshot.title)),
		duration: theme.fg("dim", formatDuration(Math.max(0, now - snapshot.createdAt))),
		activity: theme.fg("dim", latestActivity(snapshot)),
	}));
	const rendered = renderAlignedTable(rows, width, PROCESS_COLUMNS, {
		gap: "  ",
		visibleWidth,
		truncate: (value, cellWidth) => truncateToWidth(value, cellWidth),
	});
	if (allRunning.length === 1) return rendered;

	const omitted = allRunning.length - running.length;
	const header = theme.fg("muted", `${allRunning.length} background processes · /ps to inspect`)
		+ (omitted > 0 ? theme.fg("dim", ` · ${omitted} older not shown`) : "");
	return [header, ...rendered];
}

export function processWidgetComponent(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	tui?: Pick<TUI, "requestRender">,
) {
	const ticker = tui ? createSpinnerTicker(() => tui.requestRender()) : undefined;
	return {
		render(width: number): string[] {
			const contentWidth = Math.max(0, width - 1);
			return processWidgetLines(snapshots, theme, Date.now(), contentWidth)
				.map((line) => truncateToWidth(` ${line}`, width));
		},
		invalidate() {},
		dispose() {
			ticker?.dispose();
		},
	};
}
