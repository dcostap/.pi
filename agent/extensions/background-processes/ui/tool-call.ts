import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { normalizeTitle } from "../prompt.ts";
import { sanitizeTerminalText } from "../sanitize.ts";

export type BackgroundToolName =
	| "bash_bg_start"
	| "bash_bg_status"
	| "bash_bg_list"
	| "bash_bg_wait"
	| "bash_bg_kill";

export interface BackgroundStartCallArgs {
	command?: unknown;
	title?: unknown;
	working_dir?: unknown;
}

export interface BackgroundToolCallArgs extends BackgroundStartCallArgs {
	id?: unknown;
	ids?: unknown;
	timeout_seconds?: unknown;
}

export interface BackgroundToolResult {
	content: Array<{ type: string; text?: string }>;
}

export interface BackgroundToolResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export function renderBackgroundStartCall(
	args: BackgroundStartCallArgs,
	theme: Theme,
	previous?: Text,
): Text {
	return renderBackgroundToolCall("bash_bg_start", args, theme, previous);
}

export function renderBackgroundToolCall(
	toolName: BackgroundToolName,
	args: BackgroundToolCallArgs,
	theme: Theme,
	previous?: Text,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const prefix = theme.fg("toolTitle", theme.bold(toolName));

	if (toolName === "bash_bg_start") {
		const command = stringArg(args.command, false);
		const title = typeof args.title === "string" ? cleanInline(normalizeTitle(args.title)) : "";
		const workingDirectory = stringArg(args.working_dir);
		const commandDisplay = command || "...";
		const qualifiers = [title, workingDirectory ? `in ${workingDirectory}` : ""].filter(Boolean);
		const suffix = qualifiers.length > 0 ? theme.fg("muted", ` (${qualifiers.join(" • ")})`) : "";
		const highlightedCommand = command
			? highlightCode(commandDisplay, "bash").join("\n")
			: theme.fg("toolOutput", commandDisplay);
		component.setText(`${prefix} ${theme.fg("toolTitle", theme.bold("$ "))}${highlightedCommand}${suffix}`);
		return component;
	}

	if (toolName === "bash_bg_status") {
		component.setText(`${prefix}${formatIds([args.id], theme)}`);
		return component;
	}

	if (toolName === "bash_bg_wait") {
		const timeout = typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;
		const suffix = timeout === undefined ? "" : theme.fg("muted", ` (timeout ${timeout}s)`);
		component.setText(`${prefix}${formatIds(args.ids, theme)}${suffix}`);
		return component;
	}

	if (toolName === "bash_bg_kill") {
		component.setText(`${prefix}${formatIds(args.ids, theme)}`);
		return component;
	}

	component.setText(prefix);
	return component;
}

export function renderBackgroundToolResult(
	toolName: BackgroundToolName,
	result: BackgroundToolResult,
	options: BackgroundToolResultOptions,
	theme: Theme,
	previous?: Text,
	isError = false,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const text = sanitizeTerminalText(
		result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "",
	).trimEnd();

	if (!text) {
		component.setText("");
		return component;
	}

	if (isError) {
		component.setText(`\n${text.split("\n").map((line) => theme.fg("error", line)).join("\n")}`);
		return component;
	}

	const styled = text.split("\n").map((line) => styleResultLine(toolName, line, options.isPartial, theme));
	const visible = options.expanded ? styled : collapseResult(toolName, styled, theme);
	component.setText(`\n${visible.join("\n")}`);
	return component;
}

function formatIds(value: unknown, theme: Theme): string {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	const ids = values.filter((item): item is string => typeof item === "string").map(cleanInline);
	return ids.length > 0 ? ` ${theme.fg("accent", ids.join(", "))}` : "";
}

function stringArg(value: unknown, inline = true): string {
	if (typeof value !== "string") return "";
	return inline ? cleanInline(value) : sanitizeTerminalText(value);
}

function cleanInline(value: string): string {
	return sanitizeTerminalText(value).replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function styleResultLine(toolName: BackgroundToolName, line: string, isPartial: boolean, theme: Theme): string {
	if (!line) return "";
	if (isPartial) return theme.fg("warning", line);
	if (line === "---") return theme.fg("borderMuted", line);
	if (/^\[(?:Response truncated|Only the newest)/u.test(line)) return theme.fg("warning", line);
	if (/^\((?:no output|no output yet)\)$/u.test(line)) return theme.fg("muted", line);
	if (/^Use bash_bg_/u.test(line)) return theme.fg("dim", line);
	if (/^(?:All requested background processes settled\.|No background processes are tracked\.)$/u.test(line)) {
		return theme.fg("success", line);
	}
	if (/^Wait timed out\./u.test(line)) return theme.fg("warning", line);

	const started = line.match(/^Started (bg-\d+):\s*(.*)$/u);
	if (started) {
		return `${theme.fg("success", "Started")} ${theme.fg("accent", theme.bold(started[1]!))}: ${theme.fg("toolOutput", started[2]!)}`;
	}

	const processTitle = line.match(/^(bg-\d+) — (.*)$/u);
	if (processTitle) {
		return `${theme.fg("accent", theme.bold(processTitle[1]!))} ${theme.fg("muted", "—")} ${theme.fg("toolOutput", processTitle[2]!)}`;
	}

	const listEntry = line.match(/^(bg-\d+) \[([^\]]+)\] (.*)$/u);
	if (listEntry) {
		return `${theme.fg("accent", theme.bold(listEntry[1]!))} ${styleStatus(`[${listEntry[2]}]`, theme)} ${theme.fg("toolOutput", listEntry[3]!)}`;
	}

	const killEntry = line.match(/^(bg-\d+):\s*(.*)$/u);
	if (toolName === "bash_bg_kill" && killEntry) {
		const color = /pending|requested but/u.test(killEntry[2]!) ? "warning" : "success";
		return `${theme.fg("accent", theme.bold(killEntry[1]!))}: ${theme.fg(color, killEntry[2]!)}`;
	}

	const labeled = line.match(/^([A-Za-z ]+):\s*(.*)$/u);
	if (labeled) {
		const label = labeled[1]!;
		const value = labeled[2]!;
		if (label === "State") return `${theme.fg("muted", `${label}:`)} ${styleStatus(value, theme)}`;
		if (label === "Error") return `${theme.fg("error", `${label}:`)} ${theme.fg("error", value)}`;
		if (label === "Command") return `${theme.fg("muted", `${label}:`)} ${theme.fg("toolTitle", value)}`;
		return `${theme.fg("muted", `${label}:`)} ${theme.fg("toolOutput", value)}`;
	}

	return theme.fg("toolOutput", line);
}

function styleStatus(value: string, theme: Theme): string {
	const normalized = value.toLowerCase();
	const color = normalized.includes("failed")
		? "error"
		: normalized.includes("killed") || normalized.includes("stopping")
			? "warning"
			: normalized.includes("running")
				? "accent"
				: "success";
	return theme.fg(color, value);
}

function collapseResult(toolName: BackgroundToolName, lines: string[], theme: Theme): string[] {
	const limit = toolName === "bash_bg_status" ? 14 : toolName === "bash_bg_wait" ? 22 : 18;
	if (toolName === "bash_bg_start" || lines.length <= limit) return lines;

	const tailCount = toolName === "bash_bg_status" ? 5 : 8;
	const headCount = Math.max(4, limit - tailCount - 1);
	const hidden = lines.length - headCount - tailCount;
	const hint =
		theme.fg("muted", `... (${hidden} hidden lines,`) +
		` ${keyHint("app.tools.expand", "to expand")})`;
	return [...lines.slice(0, headCount), hint, ...lines.slice(-tailCount)];
}
