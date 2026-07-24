import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./protocol.ts";

interface SshToolArgs {
	action?: unknown;
	command?: unknown;
	cwd?: unknown;
	local_path?: unknown;
	remote_path?: unknown;
	overwrite?: unknown;
	mode?: unknown;
	title?: unknown;
	job_ids?: unknown;
	timeout_seconds?: unknown;
}

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
}

interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

export function renderSshCall(
	args: SshToolArgs,
	theme: Theme,
	expanded: boolean,
	previous?: Text,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const action = typeof args.action === "string" ? args.action : "...";
	const title = `${theme.fg("toolTitle", theme.bold("ssh_session"))} ${theme.fg("accent", action)}`;
	const qualifiers: string[] = [];
	if (typeof args.cwd === "string" && args.cwd) qualifiers.push(`in ${cleanInline(args.cwd)}`);
	if (Array.isArray(args.job_ids) && args.job_ids.length > 0) qualifiers.push(args.job_ids.map(String).join(", "));
	if (typeof args.timeout_seconds === "number") qualifiers.push(`timeout ${args.timeout_seconds}s`);
	if (args.overwrite === true) qualifiers.push("overwrite");
	if (typeof args.mode === "number") qualifiers.push(`mode 0${args.mode.toString(8)}`);
	const suffix = qualifiers.length > 0 ? theme.fg("muted", ` (${qualifiers.join(" • ")})`) : "";
	const transferPaths = formatTransferPaths(args);
	if (transferPaths) {
		component.setText(`${title}${suffix}\n${theme.fg("toolOutput", transferPaths)}`);
		return component;
	}

	if (typeof args.command !== "string" || !args.command) {
		component.setText(`${title}${suffix}`);
		return component;
	}

	const command = sanitizeTerminalText(args.command);
	const shown = expanded ? command : collapseCommand(command);
	const highlighted = highlightCode(shown, "bash").join("\n");
	component.setText(`${title}${suffix}\n${theme.fg("toolTitle", theme.bold("$ "))}${highlighted}`);
	return component;
}

export function renderSshResult(
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
	previous?: Text,
	isError = false,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const raw = result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
	const text = sanitizeTerminalText(raw).trimEnd();
	if (!text) {
		component.setText("");
		return component;
	}

	const lines = text.split("\n");
	const visible = options.expanded ? lines : collapseLines(lines, options.isPartial);
	const styled = visible.map((line) => styleLine(line, options.isPartial, isError, theme));
	component.setText(`\n${styled.join("\n")}`);
	return component;
}

function collapseCommand(command: string): string {
	const lines = command.split("\n");
	const limit = 12;
	const shown = lines.slice(0, limit).map((line) => line.length > 240 ? `${line.slice(0, 240)}…` : line);
	if (lines.length <= limit) return shown.join("\n");

	const hidden = lines.length - limit;
	shown.push(`# … ${hidden} more line${hidden === 1 ? "" : "s"}`);
	return shown.join("\n");
}

function collapseLines(lines: string[], isPartial: boolean): string[] {
	const limit = isPartial ? 8 : 14;
	if (lines.length <= limit) return lines;
	const headCount = isPartial ? 1 : 8;
	const tailCount = limit - headCount - 1;
	const hidden = lines.length - headCount - tailCount;
	const hint = `... (${hidden} hidden lines, ${keyHint("app.tools.expand", "to expand")})`;
	return [...lines.slice(0, headCount), hint, ...lines.slice(-tailCount)];
}

function styleLine(line: string, isPartial: boolean, isError: boolean, theme: Theme): string {
	if (!line) return "";
	if (isError) return theme.fg("error", line);
	if (/^\.\.\. \(\d+ hidden lines,/u.test(line)) return theme.fg("muted", line);
	if (isPartial) return theme.fg("warning", line);
	if (/^\[Output truncated:/u.test(line)) return theme.fg("warning", line);
	if (/^Use read with offset\/limit/u.test(line)) return theme.fg("dim", line);
	if (/^Full output/u.test(line)) return theme.fg("dim", line);
	if (/^Exit code: 0/u.test(line)) return theme.fg("success", line);
	if (/^Exit code:/u.test(line)) return theme.fg("error", line);
	if (/^(?:Uploaded|Downloaded) /u.test(line)) return theme.fg("success", line);
	if (/^(?:Local:|Remote:|SHA-256:|Remote mode:)/u.test(line)) return theme.fg("muted", line);
	if (/^(?:Started bg-|Closed SSH session|Target:|CWD:|Root access:|Jobs:)/u.test(line)) {
		return theme.fg("muted", line);
	}
	return theme.fg("toolOutput", line);
}

function cleanInline(value: string): string {
	return sanitizeTerminalText(value).replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function formatTransferPaths(args: SshToolArgs): string | undefined {
	if (typeof args.local_path !== "string" || typeof args.remote_path !== "string") return undefined;
	const local = cleanInline(args.local_path);
	const remote = cleanInline(args.remote_path);
	if (!local || !remote) return undefined;
	return args.action === "download" ? `${remote} → ${local}` : `${local} → ${remote}`;
}
