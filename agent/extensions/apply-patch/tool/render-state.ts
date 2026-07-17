import type { ExecutePatchResult } from "../patch/types.ts";
import { parsePatchActions } from "../patch/parser.ts";
import { collectionLabel, formatApplyPatchCollapsedDiff, formatApplyPatchSummary, formatPatchTarget, renderApplyPatchCall } from "./rendering.ts";

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed: string;
	collapsedDiff: string;
	expanded: string;
	status: "pending" | "partial_failure" | "failed";
	failedTargets?: string[] | undefined;
	failedActionIndexes?: number[] | undefined;
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
	failedActionIndexes?: number[] | undefined;
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
	failedActionIndexes?: number[],
): void {
	const collapsed = formatApplyPatchSummary(patchText, cwd);
	const collapsedDiff = formatApplyPatchCollapsedDiff(patchText, cwd);
	const expanded = renderApplyPatchCall(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, { cwd, patchText, collapsed, collapsedDiff, expanded, status, failedTargets, failedActionIndexes });
}

export function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[], failedActionIndexes?: number[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets, failedActionIndexes);
}

export function markApplyPatchFailure(
	toolCallId: string,
	status: "partial_failure" | "failed",
	failedTargets?: string[],
	failedActionIndexes?: number[],
): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (!existing) return;
	applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets, failedActionIndexes });
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

export type ApplyPatchSettledStatus = "success" | "partial_failure" | "failed";

interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

function stylePreviewLines(text: string, theme: RenderTheme): string {
	return text.split("\n").map((line, index) => {
		if (index === 0 || line.trim().length === 0 || /^\s*└ /.test(line)) return line;
		if (/^\s*-\s*\d+\s/.test(line)) return theme.fg("toolDiffRemoved", line);
		if (/^\s*\+\s*\d+\s/.test(line)) return theme.fg("toolDiffAdded", line);
		// Remaining body rows are context lines or section separators. File
		// headers were excluded above, so coloring the whole row cannot affect
		// clickable paths or count parsing.
		return theme.fg("toolDiffContext", line);
	}).join("\n");
}

function styledCounts(suffix: string, theme: RenderTheme): string {
	const match = suffix.match(/^ \(\+(\d+) -(\d+)\)$/);
	if (!match) return suffix;
	return ` (${theme.fg("toolDiffAdded", `+${match[1]}`)} ${theme.fg("toolDiffRemoved", `-${match[2]}`)})`;
}

function actionLabel(action: { type: string }, theme: RenderTheme): string {
	return action.type === "delete" ? `${theme.fg("toolDiffRemoved", "DELETED")} ` : "";
}

function styleHeaders(
	text: string,
	patchText: string,
	cwd: string,
	theme: RenderTheme,
	status: ApplyPatchRenderState["status"] | ApplyPatchSettledStatus,
	failedTargets?: string[],
	failedActionIndexes?: number[],
): string {
	let actions;
	try {
		actions = parsePatchActions({ text: patchText });
	} catch {
		return text;
	}
	const lines = text.split("\n");
	const titleRole = status === "failed" ? "error" : "toolTitle";
	const title = theme.fg(titleRole, theme.bold("apply_patch"));
	const actionFailed = (target: string, actionIndex: number): boolean => failedActionIndexes
		? failedActionIndexes.includes(actionIndex)
		: failedTargets?.includes(target) ?? false;
	const outcomeLabel = (target: string, actionIndex: number): string => {
		if (status !== "partial_failure") return "";
		return actionFailed(target, actionIndex)
			? theme.fg("error", "! ")
			: theme.fg("success", "✓ ");
	};
	const failureSuffix = (target: string, actionIndex: number): string => status === "partial_failure" && actionFailed(target, actionIndex)
		? theme.fg("muted", " — not applied")
		: "";

	if (actions.length === 1) {
		const action = actions[0]!;
		const suffix = lines[0]?.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
		const target = formatPatchTarget(action.path, action.movePath, cwd);
		lines[0] = `${title} ${outcomeLabel(target, 0)}${actionLabel(action, theme)}${theme.fg("accent", target)}${failureSuffix(target, 0)}${styledCounts(suffix, theme)}`;
		return lines.join("\n");
	}

	const totalSuffix = lines[0]?.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
	lines[0] = `${title} ${theme.fg("muted", collectionLabel(actions, cwd))}${styledCounts(totalSuffix, theme)}`;
	let actionIndex = 0;
	for (let index = 1; index < lines.length && actionIndex < actions.length; index += 1) {
		if (!/^  └ /.test(lines[index]!)) continue;
		const currentActionIndex = actionIndex;
		const action = actions[actionIndex++]!;
		const suffix = lines[index]!.match(/ \(\+\d+ -\d+\)$/)?.[0] ?? "";
		const target = formatPatchTarget(action.path, action.movePath, cwd);
		const styledTarget = theme.fg("accent", target);
		lines[index] = `  └ ${outcomeLabel(target, currentActionIndex)}${actionLabel(action, theme)}${styledTarget}${failureSuffix(target, currentActionIndex)}${styledCounts(suffix, theme)}`;
	}
	return lines.join("\n");
}

function tokenSuffix(tokens: number | undefined, theme: RenderTheme): string {
	if (!tokens || tokens <= 0) return "";
	const display = tokens < 1000 ? String(Math.round(tokens)) : tokens < 10_000 ? `${Number((tokens / 1000).toFixed(1))}k` : `${Math.round(tokens / 1000)}k`;
	return ` ${theme.fg("dim", `↓${display}`)}`;
}

interface PendingAction {
	type: "add" | "update" | "delete";
	path: string;
	movePath?: string;
}

const MAX_PENDING_ACTIONS = 20;

function pendingActions(patchText: string): PendingAction[] {
	const lines = patchText.split("\n");
	// The last streamed line may still be growing. Wait for its newline so the
	// displayed path never flickers through partial values.
	if (!patchText.endsWith("\n")) lines.pop();

	const actions: PendingAction[] = [];
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
		if (header) {
			const type = header[1]!.toLowerCase() as PendingAction["type"];
			const path = header[2]!.trim();
			if (path) actions.push({ type, path });
			continue;
		}

		const move = line.match(/^\*\*\* Move to: (.+)$/);
		const previous = actions.at(-1);
		if (move && previous?.type === "update") {
			const movePath = move[1]!.trim();
			if (movePath) previous.movePath = movePath;
		}
	}
	return actions;
}

function pendingActionLabel(action: PendingAction, theme: RenderTheme): string {
	if (action.movePath) return theme.fg("accent", "MOVING");
	if (action.type === "add") return theme.fg("toolDiffAdded", "ADDING");
	if (action.type === "delete") return theme.fg("toolDiffRemoved", "DELETING");
	return theme.fg("accent", "EDITING");
}

function pendingCall(patchText: string, cwd: string, tokens: number | undefined, theme: RenderTheme): string {
	const lines = [`${theme.fg("toolTitle", theme.bold("apply_patch"))}${tokenSuffix(tokens, theme)}`];
	const actions = pendingActions(patchText);
	for (const action of actions.slice(0, MAX_PENDING_ACTIONS)) {
		lines.push(`  └ ${pendingActionLabel(action, theme)} ${formatPatchTarget(action.path, action.movePath, cwd)}`);
	}
	if (actions.length > MAX_PENDING_ACTIONS) {
		lines.push(`    ${theme.fg("dim", `… ${actions.length - MAX_PENDING_ACTIONS} more actions`)}`);
	}
	return lines.join("\n");
}

export function renderApplyPatchCallFromState(args: { input?: unknown | undefined }, theme: RenderTheme, context?: { toolCallId?: string | undefined; cwd?: string | undefined; expanded?: boolean | undefined; argsComplete?: boolean | undefined; showCollapsedDiff?: boolean | undefined; outputTokens?: number | undefined; settledStatus?: ApplyPatchSettledStatus | undefined }): string {
	const patchText = typeof args.input === "string" ? args.input : "";
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd ?? process.cwd();
	const pending = pendingCall(patchText, cwd, context?.outputTokens, theme);
	// Native edit waits for complete arguments before constructing its preview.
	// Rendering a growing diff on every streamed JSON delta leaves stale ANSI
	// background cells behind in terminals when hunks wrap or change height.
	// Historical tool rows are rebuilt from the stored call and result without
	// replaying setArgsComplete(). A settled result is therefore also proof that
	// the persisted arguments are complete.
	if (context?.argsComplete === false && !context.settledStatus) return pending;
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
	const status = context?.settledStatus ?? cached?.status ?? "pending";
	const statusText = status === "partial_failure"
		? renderPartialFailureCall(
			baseText,
			{ fg: (_role, text) => text },
			cached?.failedActionIndexes ? undefined : cached?.failedTargets,
		)
		: status === "failed"
			? renderFailedCall(baseText, { fg: (_role, text) => text }, cached?.failedTargets)
			: baseText;
	const styled = styleHeaders(
		stylePreviewLines(statusText, theme),
		effectivePatchText,
		cwd,
		theme,
		status,
		cached?.failedTargets,
		cached?.failedActionIndexes,
	);
	const lines = styled.split("\n");
	lines[0] = `${lines[0]}${tokenSuffix(context?.outputTokens, theme)}`;
	return lines.join("\n");
}
