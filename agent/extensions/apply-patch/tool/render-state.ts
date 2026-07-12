import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutePatchResult } from "../patch/types.ts";
import { parsePatchActions } from "../patch/parser.ts";
import { formatApplyPatchCollapsedDiff, formatApplyPatchSummary, formatPatchTarget, renderApplyPatchCall } from "./rendering.ts";

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed: string;
	collapsedDiff: string;
	expanded: string;
	status: "pending" | "partial_failure" | "failed";
	failedTargets?: string[] | undefined;
}

export interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

export interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	error: string;
	failedTargets?: string[] | undefined;
	appliedFiles: string[];
	failedFiles: string[];
	recoveryInstructions: {
		mustReadFiles: string[];
		mustNotReadFiles: string[];
	};
}

export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

export function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return typeof details === "object" && details !== null && "status" in details && "result" in details;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" | "failed" = "pending",
	failedTargets?: string[],
): void {
	const collapsed = formatApplyPatchSummary(patchText, cwd);
	const collapsedDiff = formatApplyPatchCollapsedDiff(patchText, cwd);
	const expanded = renderApplyPatchCall(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, { cwd, patchText, collapsed, collapsedDiff, expanded, status, failedTargets });
}

export function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}

export function markApplyPatchFailure(toolCallId: string, status: "partial_failure" | "failed", failedTargets?: string[]): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (!existing) return;
	applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets });
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
	const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
	if (!suffixMatch) return undefined;
	const suffix = suffixMatch[0]!;
	const prefixAndTarget = line.slice(0, -suffix.length);
	const candidatePrefixes = ["• Edit partially failed ", "• Added ", "• Edited ", "• Deleted ", "  └ ", "    "];
	for (const prefix of candidatePrefixes) {
		if (prefixAndTarget === `${prefix}${failedTarget}`) {
			return `${prefix}${failedTarget} failed${suffix}`;
		}
	}
	return undefined;
}

function renderPartialFailureCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("warning", "• Edit partially failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit partially failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines.map((line, index) => {
		if (failedLineIndexes.has(index)) return theme.fg("error", line);
		if (index === 0) return theme.fg("warning", line);
		return line;
	}).join("\n");
}

function renderFailedCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("error", "• Edit failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines.map((line, index) => failedLineIndexes.has(index) || index === 0 ? theme.fg("error", line) : line).join("\n");
}

interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

function clickablePath(display: string, path: string, cwd: string): string {
	const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
	return `\u001b]8;;${pathToFileURL(absolutePath).href}\u0007${display}\u001b]8;;\u0007`;
}

function styledCounts(suffix: string, theme: RenderTheme): string {
	const match = suffix.match(/^ \(\+(\d+) -(\d+)\)$/);
	if (!match) return suffix;
	return ` (${theme.fg("toolDiffAdded", `+${match[1]}`)} ${theme.fg("toolDiffRemoved", `-${match[2]}`)})`;
}

function styleHeaders(text: string, patchText: string, cwd: string, theme: RenderTheme, status: ApplyPatchRenderState["status"]): string {
	let actions;
	try {
		actions = parsePatchActions({ text: patchText });
	} catch {
		return text;
	}
	const lines = text.split("\n");
	const titleRole = status === "failed" ? "error" : status === "partial_failure" ? "warning" : "toolTitle";
	const title = theme.fg(titleRole, theme.bold("apply_patch"));

	if (actions.length === 1) {
		const action = actions[0]!;
		const suffix = lines[0]?.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
		const target = formatPatchTarget(action.path, action.movePath, cwd);
		const linkTarget = action.movePath ?? action.path;
		lines[0] = `${title} ${theme.fg("accent", clickablePath(target, linkTarget, cwd))}${styledCounts(suffix, theme)}`;
		return lines.join("\n");
	}

	const totalSuffix = lines[0]?.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
	lines[0] = `${title} ${theme.fg("muted", `${actions.length} files`)}${styledCounts(totalSuffix, theme)}`;
	let actionIndex = 0;
	for (let index = 1; index < lines.length && actionIndex < actions.length; index += 1) {
		if (!/^  └ /.test(lines[index]!)) continue;
		const action = actions[actionIndex++]!;
		const suffix = lines[index]!.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
		const target = formatPatchTarget(action.path, action.movePath, cwd);
		const linkTarget = action.movePath ?? action.path;
		const linked = theme.fg("accent", clickablePath(target, linkTarget, cwd));
		lines[index] = `  └ ${linked}${styledCounts(suffix, theme)}`;
	}
	return lines.join("\n");
}

function tokenSuffix(tokens: number | undefined, theme: RenderTheme): string {
	if (!tokens || tokens <= 0) return "";
	const display = tokens < 1000 ? String(Math.round(tokens)) : tokens < 10_000 ? `${Number((tokens / 1000).toFixed(1))}k` : `${Math.round(tokens / 1000)}k`;
	return ` ${theme.fg("dim", `↓${display}`)}`;
}

function pendingHeader(patchText: string, cwd: string, tokens: number | undefined, theme: RenderTheme): string {
	let text = theme.fg("toolTitle", theme.bold("apply_patch"));
	const target = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]?.trim();
	if (target) text += ` ${theme.fg("accent", clickablePath(target, target, cwd))}`;
	return `${text}${tokenSuffix(tokens, theme)}`;
}

export function renderApplyPatchCallFromState(args: { input?: unknown | undefined }, theme: RenderTheme, context?: { toolCallId?: string | undefined; cwd?: string | undefined; expanded?: boolean | undefined; argsComplete?: boolean | undefined; showCollapsedDiff?: boolean | undefined; outputTokens?: number | undefined }): string {
	const patchText = typeof args.input === "string" ? args.input : "";
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd ?? process.cwd();
	const pending = pendingHeader(patchText, cwd, context?.outputTokens, theme);
	if (patchText.trim().length === 0) return pending;
	const effectivePatchText = cached?.patchText ?? patchText;
	const baseText = context?.expanded
		? cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd)
		: context?.showCollapsedDiff
			? cached?.collapsedDiff ?? formatApplyPatchCollapsedDiff(effectivePatchText, cwd)
		: cached?.collapsed ?? formatApplyPatchSummary(effectivePatchText, cwd);
	if (baseText.trim().length === 0) {
		if (cached?.status === "failed") return theme.fg("error", "• Edit failed");
		return pending;
	}
	const status = cached?.status ?? "pending";
	const statusText = status === "partial_failure"
		? renderPartialFailureCall(baseText, { fg: (_role, text) => text }, cached?.failedTargets)
		: status === "failed"
			? renderFailedCall(baseText, { fg: (_role, text) => text }, cached?.failedTargets)
			: baseText;
	const styled = styleHeaders(statusText, effectivePatchText, cwd, theme, status);
	const lines = styled.split("\n");
	lines[0] = `${lines[0]}${tokenSuffix(context?.outputTokens, theme)}`;
	return lines.join("\n");
}
