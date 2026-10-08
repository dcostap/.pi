import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { highlightBashCommand } from "../../_shared/bash-command-highlight.ts";
import { formatDuration, type KillView, type ProcessView } from "../formatting.ts";
import { normalizeTitle, stripBackgroundNotice } from "../prompt.ts";
import { sanitizeTerminalText } from "../sanitize.ts";

export type BackgroundToolName = "bash_bg_start" | "bash_bg_status" | "bash_bg_wait" | "bash_bg_kill";

export interface BackgroundToolCallArgs {
	command?: unknown;
	title?: unknown;
	working_dir?: unknown;
	id?: unknown;
	ids?: unknown;
	timeout_seconds?: unknown;
}

export interface BackgroundToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export interface BackgroundToolResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface BackgroundCompletionMessage {
	content: string;
	details?: unknown;
}

export type BackgroundProcessLookup = (id: string) => { title: string | undefined } | undefined;

/** Details of a foreground bash call that was moved to the background. */
export interface BashTransferView {
	id: string;
	reason: "timeout" | "steer";
	timeoutSeconds: number;
}

/** Collapsed output height, matching Pi's built-in bash tool. */
const PREVIEW_LINES = 5;
/** Per-process output height when one row shows several processes. */
const MULTI_PREVIEW_LINES = 3;
const LIST_COLLAPSED_ROWS = 8;

// ---------------------------------------------------------------------------
// Tool call rows

export function renderBackgroundToolCall(
	toolName: BackgroundToolName,
	args: BackgroundToolCallArgs,
	theme: Theme,
	previous?: Text,
	lookupProcess?: BackgroundProcessLookup,
): Text {
	const component = previous ?? new Text("", 0, 0);

	if (toolName === "bash_bg_start") {
		const command = typeof args.command === "string" ? sanitizeTerminalText(args.command) : "";
		const title = typeof args.title === "string" ? cleanInline(normalizeTitle(args.title)) : "";
		const workingDirectory = typeof args.working_dir === "string" ? cleanInline(args.working_dir) : "";
		const qualifiers = ["background", title, workingDirectory ? `in ${workingDirectory}` : ""].filter(Boolean);
		const commandDisplay = command ? highlightBashCommand(command) : theme.fg("toolOutput", "...");
		component.setText(
			theme.fg("toolTitle", theme.bold("$ ")) + commandDisplay + theme.fg("muted", ` (${qualifiers.join(" · ")})`),
		);
		return component;
	}

	const label = toolName === "bash_bg_status" ? "bg status" : toolName === "bash_bg_wait" ? "bg wait" : "bg stop";
	const ids = toolName === "bash_bg_status" ? idList(args.id) : idList(args.ids);
	const target = toolName === "bash_bg_status" && ids.length === 0
		? theme.fg("muted", " all processes")
		: formatIds(ids, theme, lookupProcess);
	const timeout = toolName === "bash_bg_wait" && typeof args.timeout_seconds === "number"
		? theme.fg("muted", ` (timeout ${args.timeout_seconds}s)`)
		: "";
	component.setText(theme.fg("toolTitle", theme.bold(label)) + target + timeout);
	return component;
}

function idList(value: unknown): string[] {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return values.filter((item): item is string => typeof item === "string").map(cleanInline).filter(Boolean);
}

function formatIds(ids: string[], theme: Theme, lookupProcess?: BackgroundProcessLookup): string {
	if (ids.length === 0) return "";
	return ` ${ids.map((id) => {
		const title = lookupProcess?.(id)?.title;
		return theme.fg("accent", id) + (title ? theme.fg("muted", ` ${cleanInline(title)}`) : "");
	}).join(theme.fg("muted", ", "))}`;
}

// ---------------------------------------------------------------------------
// Tool result rows

export function renderBackgroundToolResult(
	toolName: BackgroundToolName,
	result: BackgroundToolResult,
	options: BackgroundToolResultOptions,
	theme: Theme,
	previous?: Component,
	isError = false,
): Component {
	const component = previous instanceof Container ? previous : new Container();
	component.clear();
	const text = stripBackgroundNotice(sanitizeTerminalText(textContent(result)).trimEnd());
	const details = (result.details ?? {}) as Record<string, unknown>;

	if (isError) {
		if (text) component.addChild(new Text(`\n${text.split("\n").map((line) => theme.fg("error", line)).join("\n")}`, 0, 0));
		return component;
	}
	if (options.expanded && !options.isPartial && text) {
		component.addChild(new Text(`\n${text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")}`, 0, 0));
		return component;
	}

	const single = asView(details.process);
	const many = Array.isArray(details.processes) ? details.processes.map(asView).filter((view) => view !== undefined) : [];

	if (toolName === "bash_bg_start" && single) {
		if (single.settled) addProcessBlock(component, single, theme, options.expanded, PREVIEW_LINES);
		else component.addChild(new Text(`\n${theme.fg("muted", "→ running in background as ")}${theme.fg("accent", single.id)}`, 0, 0));
		return component;
	}

	if (toolName === "bash_bg_status" && single) {
		addProcessBlock(component, single, theme, options.expanded, PREVIEW_LINES);
		return component;
	}

	if (toolName === "bash_bg_status" && Array.isArray(details.processes)) {
		addProcessList(component, many, Number(details.omitted) || 0, theme, options.expanded);
		return component;
	}

	if (toolName === "bash_bg_wait" && many.length > 0) {
		if (many.length === 1) addProcessBlock(component, many[0]!, theme, options.expanded, PREVIEW_LINES);
		else for (const view of many) addProcessBlock(component, view, theme, options.expanded, MULTI_PREVIEW_LINES, true);
		const running = many.filter((view) => !view.settled).map((view) => view.id);
		if (!options.isPartial && running.length > 0) {
			const reason = details.interruptedBySteer
				? "wait interrupted by your message"
				: `wait timed out${typeof details.timeoutSeconds === "number" ? ` after ${details.timeoutSeconds}s` : ""}`;
			component.addChild(new Text(`\n${theme.fg("warning", `${reason} · still running: ${running.join(", ")}`)}`, 0, 0));
		}
		return component;
	}

	if (toolName === "bash_bg_kill" && Array.isArray(details.results)) {
		const lines = (details.results as unknown[]).flatMap((value) => {
			const item = value as Partial<KillView> | undefined;
			const view = asView(item?.process);
			return view && item?.outcome ? [killLine(item.outcome, view, theme)] : [];
		});
		component.addChild(new Text(`\n${lines.join("\n")}`, 0, 0));
		return component;
	}

	// Results from older sessions or unexpected shapes: show the text like bash output.
	if (text) addOutputPreview(component, text, theme, options.expanded, PREVIEW_LINES);
	return component;
}

/** Status line added below a foreground bash result that moved to the background. */
export function renderBashTransferLine(transfer: BashTransferView, theme: Theme): Text {
	const reason = transfer.reason === "steer" ? "you sent a message" : `still running after ${transfer.timeoutSeconds}s`;
	return new Text(
		`\n${theme.fg("warning", "→ moved to background as ")}${theme.fg("accent", theme.bold(transfer.id))}${theme.fg("muted", ` · ${reason}`)}`,
		0,
		0,
	);
}

export function asBashTransfer(value: unknown): BashTransferView | undefined {
	if (!value || typeof value !== "object") return undefined;
	const transfer = value as Partial<BashTransferView>;
	if (typeof transfer.id !== "string" || (transfer.reason !== "timeout" && transfer.reason !== "steer")) return undefined;
	return { id: transfer.id, reason: transfer.reason, timeoutSeconds: Number(transfer.timeoutSeconds) || 0 };
}

// ---------------------------------------------------------------------------
// Automatic completion messages

export function renderBackgroundCompletionMessage(
	message: BackgroundCompletionMessage,
	options: Pick<BackgroundToolResultOptions, "expanded">,
	theme: Theme,
): Box {
	const details = (message.details ?? {}) as { processes?: unknown };
	const views = Array.isArray(details.processes) ? details.processes.map(asView).filter((view) => view !== undefined) : [];
	const failed = views.some((view) => view.status === "failed");
	const box = new Box(1, 1, (line) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", line));
	const body = new Container();

	if (options.expanded || views.length === 0) {
		const text = sanitizeTerminalText(message.content).trimEnd();
		body.addChild(new Text(theme.fg("toolTitle", theme.bold("background process finished")), 0, 0));
		addOutputPreview(body, text, theme, options.expanded, PREVIEW_LINES);
	} else {
		views.forEach((view, index) => {
			body.addChild(new Text(`${index === 0 ? "" : "\n"}${processHeadline(view, theme, true)}`, 0, 0));
			if (view.preview) addOutputPreview(body, view.preview, theme, false, views.length === 1 ? PREVIEW_LINES : MULTI_PREVIEW_LINES);
		});
	}
	box.addChild(body);
	return box;
}

// ---------------------------------------------------------------------------
// Building blocks

function addProcessBlock(
	container: Container,
	view: ProcessView,
	theme: Theme,
	expanded: boolean,
	previewLines: number,
	withHeadline = false,
): void {
	if (withHeadline) container.addChild(new Text(`\n${processHeadline(view, theme, false)}`, 0, 0));
	if (view.preview) addOutputPreview(container, view.preview, theme, expanded, previewLines);
	else if (!withHeadline) container.addChild(new Text(`\n${theme.fg("muted", view.settled ? "(no output)" : "(no output yet)")}`, 0, 0));
	if (view.errorText) container.addChild(new Text(theme.fg("error", cleanInline(view.errorText)), 0, 0));
	if (view.fullOutputPath) container.addChild(new Text(`\n${theme.fg("warning", `[Full output: ${view.fullOutputPath}]`)}`, 0, 0));
	if (!withHeadline) container.addChild(new Text(`\n${statusFooter(view, theme)}`, 0, 0));
}

function addProcessList(container: Container, views: ProcessView[], omitted: number, theme: Theme, expanded: boolean): void {
	if (views.length === 0) {
		container.addChild(new Text(`\n${theme.fg("muted", "No background processes.")}`, 0, 0));
		return;
	}
	const visible = expanded ? views : views.slice(-LIST_COLLAPSED_ROWS);
	const hidden = views.length - visible.length + omitted;
	const lines = visible.map((view) => processHeadline(view, theme, false));
	if (hidden > 0) lines.unshift(theme.fg("muted", `... (${hidden} older,`) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`);
	container.addChild(new Text(`\n${lines.join("\n")}`, 0, 0));
}

/** One line: icon, id, title, and status summary. */
function processHeadline(view: ProcessView, theme: Theme, finishedWording: boolean): string {
	const [icon, color] = statusIcon(view);
	const verb = finishedWording && view.status === "done" ? "finished" : statusWord(view);
	return [
		theme.fg(color, icon),
		theme.fg("accent", theme.bold(view.id)),
		theme.fg("toolOutput", cleanInline(view.title)),
		theme.fg("muted", `· ${[verb, formatDuration(view.elapsedMs)].join(" · ")}`),
	].join(" ");
}

function statusFooter(view: ProcessView, theme: Theme): string {
	const [icon, color] = statusIcon(view);
	const parts = [formatDuration(view.elapsedMs)];
	if (view.capturedBytes > 0) parts.push(formatSize(view.capturedBytes));
	return `${theme.fg(color, `${icon} ${statusWord(view)}`)}${theme.fg("muted", ` · ${parts.join(" · ")}`)}`;
}

function statusIcon(view: ProcessView): [string, "accent" | "success" | "error" | "warning"] {
	if (!view.settled) return ["●", view.killRequested ? "warning" : "accent"];
	if (view.status === "done") return ["✓", "success"];
	if (view.status === "killed") return ["■", "warning"];
	return ["✗", "error"];
}

function statusWord(view: ProcessView): string {
	if (!view.settled) return view.killRequested ? "stopping" : "running";
	if (view.status === "killed") return "stopped";
	if (view.exitCode !== undefined && view.exitCode !== null) return `exit ${view.exitCode}`;
	return view.status;
}

function killLine(outcome: KillView["outcome"], view: ProcessView, theme: Theme): string {
	const name = `${theme.fg("accent", theme.bold(view.id))} ${theme.fg("toolOutput", cleanInline(view.title))}`;
	switch (outcome) {
		case "killed":
			return `${theme.fg("warning", "■")} ${name} ${theme.fg("muted", "stopped")}`;
		case "already-settled":
			return `${theme.fg("muted", "·")} ${name} ${theme.fg("muted", `had already finished (${statusWord(view)})`)}`;
		case "settled-after-request":
			return `${theme.fg("muted", "·")} ${name} ${theme.fg("muted", `finished on its own (${statusWord(view)})`)}`;
		case "termination-pending":
			return `${theme.fg("warning", "●")} ${name} ${theme.fg("warning", "stop requested; not yet confirmed")}`;
	}
}

/** Output styled and collapsed like Pi's bash tool: the last lines by visual height, with an expand hint. */
function addOutputPreview(container: Container, text: string, theme: Theme, expanded: boolean, maxLines: number): void {
	const output = text.replace(/\s+$/u, "");
	if (!output) return;
	const styled = output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
	if (expanded) {
		container.addChild(new Text(`\n${styled}`, 0, 0));
		return;
	}
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	container.addChild({
		render(width: number): string[] {
			if (cachedWidth !== width) {
				const preview = truncateToVisualLines(styled, maxLines, width, 0, "end");
				const hint = preview.skippedCount > 0
					? [truncateToWidth(
						theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
						width,
						"...",
					)]
					: [];
				cachedLines = ["", ...hint, ...preview.visualLines];
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
		},
	});
}

function asView(value: unknown): ProcessView | undefined {
	if (!value || typeof value !== "object") return undefined;
	const view = value as Partial<ProcessView>;
	if (typeof view.id !== "string" || typeof view.status !== "string") return undefined;
	return {
		...view,
		id: view.id,
		title: typeof view.title === "string" ? view.title : view.id,
		command: typeof view.command === "string" ? view.command : "",
		status: view.status,
		settled: view.settled ?? view.status !== "running",
		killRequested: view.killRequested ?? false,
		elapsedMs: typeof view.elapsedMs === "number" ? view.elapsedMs : 0,
		capturedBytes: typeof view.capturedBytes === "number" ? view.capturedBytes : 0,
	} as ProcessView;
}

function textContent(result: BackgroundToolResult): string {
	return result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
}

function cleanInline(value: string): string {
	return sanitizeTerminalText(value).replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}
