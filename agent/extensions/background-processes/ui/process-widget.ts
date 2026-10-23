import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { renderAlignedTable, type AlignedColumn } from "../../_shared/aligned-table.ts";
import { createSpinnerTicker, spinnerFrame } from "../../_shared/spinner.ts";
import { cleanInline, formatDuration } from "../formatting.ts";
import type { BackgroundProcessSnapshot } from "../manager.ts";
import { sanitizeTerminalText } from "../sanitize.ts";
import { getOutputWindow } from "./output-view.ts";

const MAX_WIDGET_ROWS = 5;
const DETAIL_INDENT = "    ";
const DETAIL_COMMAND_LINES = 8;
const DETAIL_OUTPUT_LINES = 5;

type ProcessWidgetRow = {
	state: string;
	id: string;
	title: string;
	duration: string;
	activity: string;
};

/** One rendered widget line. `id` names the process that a click on this line toggles. */
export type ProcessWidgetLine = { text: string; id?: string };

export type ProcessWidgetOptions = {
	/** The process that shows its details below its row. */
	expandedId?: string;
	/** Called when the user clicks a process row or its details. */
	onToggle?: (id: string) => void;
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

function commandLines(command: string, width: number): string[] {
	const wrapped = sanitizeTerminalText(command)
		.trim()
		.split(/\r?\n/gu)
		.flatMap((line, index) => wrapTextWithAnsi(`${index === 0 ? "$ " : "  "}${line}`, width));
	if (wrapped.length <= DETAIL_COMMAND_LINES) return wrapped;
	const shown = wrapped.slice(0, DETAIL_COMMAND_LINES);
	shown[shown.length - 1] = truncateToWidth(`${shown.at(-1)} …`, width, "…");
	return shown;
}

function detailLines(snapshot: BackgroundProcessSnapshot, theme: Theme, width: number): string[] {
	const innerWidth = Math.max(1, width - DETAIL_INDENT.length);
	const facts = [
		`cwd ${cleanInline(snapshot.cwd)}`,
		formatSize(snapshot.output.totalBytes),
		snapshot.output.fullOutputPath ? `full output ${cleanInline(snapshot.output.fullOutputPath)}` : "",
	].filter(Boolean).join(" · ");
	const output = getOutputWindow(snapshot, Math.max(1, innerWidth - 2), DETAIL_OUTPUT_LINES, 0).lines;
	const lines = [
		...commandLines(snapshot.command, innerWidth).map((line) => theme.fg("toolOutput", line)),
		...wrapTextWithAnsi(facts, innerWidth).map((line) => theme.fg("muted", line)),
		...output.map((line) => `${theme.fg("dim", "│")} ${theme.fg("dim", line)}`),
	];
	return lines.map((line) => truncateToWidth(`${DETAIL_INDENT}${line}`, width));
}

export function processWidgetRows(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = Number.POSITIVE_INFINITY,
	expandedId?: string,
): ProcessWidgetLine[] {
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
	const lines = running.flatMap((snapshot, index): ProcessWidgetLine[] => {
		const row = { text: rendered[index]!, id: snapshot.id };
		if (snapshot.id !== expandedId) return [row];
		const detailWidth = Number.isFinite(width) ? width : 120;
		return [row, ...detailLines(snapshot, theme, detailWidth).map((text) => ({ text, id: snapshot.id }))];
	});
	if (allRunning.length === 1) return lines;

	const omitted = allRunning.length - running.length;
	const header = theme.fg("muted", `${allRunning.length} background processes · /ps to inspect`)
		+ (omitted > 0 ? theme.fg("dim", ` · ${omitted} older not shown`) : "");
	return [{ text: header }, ...lines];
}

export function processWidgetLines(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = Number.POSITIVE_INFINITY,
	expandedId?: string,
): string[] {
	return processWidgetRows(snapshots, theme, now, width, expandedId).map((line) => line.text);
}

export function processWidgetComponent(
	snapshots: readonly BackgroundProcessSnapshot[],
	theme: Theme,
	tui?: Pick<TUI, "requestRender">,
	options: ProcessWidgetOptions = {},
) {
	const ticker = tui ? createSpinnerTicker(() => tui.requestRender()) : undefined;
	let renderedIds: (string | undefined)[] = [];
	return {
		render(width: number): string[] {
			const contentWidth = Math.max(0, width - 1);
			const rows = processWidgetRows(snapshots, theme, Date.now(), contentWidth, options.expandedId);
			renderedIds = rows.map((row) => row.id);
			return rows.map((row) => truncateToWidth(` ${row.text}`, width));
		},
		// Fullscreen mode only: a left click on a process row toggles its details.
		handleMouse(event: { type: string; button?: string; y: number }) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const id = renderedIds[event.y];
			if (!id || !options.onToggle) return undefined;
			options.onToggle(id);
			return { handled: true };
		},
		invalidate() {},
		dispose() {
			ticker?.dispose();
		},
	};
}
