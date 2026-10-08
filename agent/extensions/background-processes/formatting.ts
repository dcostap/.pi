import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
	BackgroundProcessOrigin,
	BackgroundProcessSnapshot,
	BackgroundProcessStatus,
	KillOutcome,
	KillResultItem,
	WaitResult,
} from "./manager.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

export interface OutputBudget {
	maxBytes: number;
	maxLines: number;
}

export const STATUS_BUDGET: OutputBudget = { maxBytes: 24 * 1024, maxLines: 400 };
export const AUTO_BUDGET: OutputBudget = { maxBytes: 12 * 1024, maxLines: 80 };
export const WAIT_ENTRY_BUDGET: OutputBudget = { maxBytes: 16 * 1024, maxLines: 250 };
export const WAIT_TOTAL_BYTES = 48 * 1024;
export const WAIT_LIVE_BUDGET: OutputBudget = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
export const LIST_MAX_ENTRIES = 30;
/** Output kept in tool details for the collapsed transcript preview. */
export const PREVIEW_BUDGET: OutputBudget = { maxBytes: 4 * 1024, maxLines: 20 };

/** Structured process state stored in tool details. Renderers use it instead of parsing model text. */
export interface ProcessView {
	id: string;
	title: string;
	command: string;
	cwd: string;
	origin: BackgroundProcessOrigin;
	status: BackgroundProcessStatus;
	settled: boolean;
	killRequested: boolean;
	exitCode?: number | null;
	errorText?: string;
	createdAt: number;
	settledAt?: number;
	elapsedMs: number;
	capturedBytes: number;
	droppedBytes: number;
	totalLines: number;
	fullOutputPath?: string;
	/** Newest output lines, sanitized and bounded. Omitted from list views. */
	preview?: string;
}

export function processView(
	snapshot: BackgroundProcessSnapshot,
	options: { preview?: boolean; now?: number } = {},
): ProcessView {
	const view: ProcessView = {
		id: snapshot.id,
		title: snapshot.title,
		command: snapshot.command,
		cwd: snapshot.cwd,
		origin: snapshot.origin,
		status: snapshot.status,
		settled: snapshot.settled,
		killRequested: snapshot.killRequested,
		exitCode: snapshot.exitCode,
		errorText: snapshot.errorText,
		createdAt: snapshot.createdAt,
		settledAt: snapshot.settledAt,
		elapsedMs: Math.max(0, (snapshot.settledAt ?? options.now ?? Date.now()) - snapshot.createdAt),
		capturedBytes: snapshot.output.totalBytes,
		droppedBytes: snapshot.output.droppedBytes,
		totalLines: snapshot.output.totalLines,
		fullOutputPath: snapshot.output.fullOutputPath,
	};
	if (options.preview !== false) {
		view.preview = truncateTail(sanitizeTerminalText(snapshot.output.text).replace(/\s+$/u, ""), PREVIEW_BUDGET).content;
	}
	return view;
}

export interface KillView {
	outcome: KillOutcome;
	process: ProcessView;
}

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatStartResult(snapshot: BackgroundProcessSnapshot): string {
	return [
		`Started ${snapshot.id} (${cleanInline(snapshot.title)}) in ${cleanInline(snapshot.cwd)}. It is still running.`,
		"Its completion will be reported automatically. Continue useful work; use bash_bg_wait only when further work depends on it.",
	].join("\n");
}

export function formatProcess(
	snapshot: BackgroundProcessSnapshot,
	budget: OutputBudget = STATUS_BUDGET,
	now = Date.now(),
): string {
	const elapsed = (snapshot.settledAt ?? now) - snapshot.createdAt;
	const lines = [
		`${snapshot.id} — ${cleanInline(snapshot.title)}`,
		`State: ${snapshot.status}${snapshot.killRequested && !snapshot.settled ? " (termination requested)" : ""}`,
		`Elapsed: ${formatDuration(elapsed)}`,
		`Working directory: ${cleanInline(snapshot.cwd)}`,
		`Command: ${sanitizeTerminalText(snapshot.command)}`,
	];
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode === null ? "none" : snapshot.exitCode}`);
	if (snapshot.errorText) lines.push(`Error: ${cleanInline(snapshot.errorText)}`);
	lines.push(
		`Captured: ${formatSize(snapshot.output.totalBytes)}` +
			(snapshot.output.truncated ? ` (${formatSize(snapshot.output.droppedBytes)} discarded from the oldest output)` : ""),
	);
	if (snapshot.output.fullOutputPath) lines.push(`Full output: ${snapshot.output.fullOutputPath}`);
	if (snapshot.output.fileError) lines.push(`Full output could not be saved: ${cleanInline(snapshot.output.fileError)}`);

	const sanitized = sanitizeTerminalText(snapshot.output.text).replace(/\s+$/u, "");
	if (!sanitized) {
		lines.push("", snapshot.settled ? "(no output)" : "(no output yet)");
		return lines.join("\n");
	}

	const truncated = truncateTail(sanitized, budget);
	lines.push("", truncated.content);
	if (truncated.truncated) {
		lines.push("", `[Response truncated to the newest ${formatSize(truncated.outputBytes)}.]`);
	}
	if (snapshot.output.truncated) {
		lines.push(`[Only the newest ${formatSize(snapshot.output.retainedBytes)} remains in memory.]`);
	}
	return lines.join("\n");
}

export function formatWaitUpdate(snapshots: BackgroundProcessSnapshot[], now = Date.now()): string {
	if (snapshots.length === 0) return "Waiting for background process output…";
	const multiple = snapshots.length > 1;
	return snapshots.map((snapshot) => {
		const lines: string[] = [];
		if (multiple) lines.push(`${snapshot.id} — ${cleanInline(snapshot.title)}`, "");

		const sanitized = sanitizeTerminalText(snapshot.output.text).replace(/\s+$/u, "");
		const bounded = truncateTail(sanitized, WAIT_LIVE_BUDGET);
		lines.push(bounded.content || (snapshot.settled ? "(no output)" : "(no output yet)"));

		const warnings: string[] = [];
		if (snapshot.output.fullOutputPath) warnings.push(`Full output: ${snapshot.output.fullOutputPath}`);
		if (snapshot.output.fileError) warnings.push(`Full output could not be saved: ${cleanInline(snapshot.output.fileError)}`);
		if (snapshot.output.totalLines > DEFAULT_MAX_LINES) {
			warnings.push(`Truncated: showing the latest ${bounded.outputLines} of ${snapshot.output.totalLines} lines`);
		} else if (snapshot.output.totalBytes > DEFAULT_MAX_BYTES || bounded.truncated) {
			warnings.push(`Truncated: ${bounded.outputLines} lines shown (${formatSize(DEFAULT_MAX_BYTES)} limit)`);
		}
		if (warnings.length > 0) lines.push("", `[${warnings.join(". ")}]`);

		const elapsed = (snapshot.settledAt ?? now) - snapshot.createdAt;
		lines.push("", `${snapshot.settled ? "Took" : "Elapsed"} ${formatPreciseDuration(elapsed)}`);
		return lines.join("\n");
	}).join("\n\n---\n\n");
}

export function formatList(snapshots: BackgroundProcessSnapshot[], now = Date.now()): string {
	if (snapshots.length === 0) return "No background processes are tracked.";
	const visible = recentListSnapshots(snapshots);
	const omitted = snapshots.length - visible.length;
	const lines = visible
		.map((snapshot) => {
			const elapsed = (snapshot.settledAt ?? now) - snapshot.createdAt;
			const exit = snapshot.exitCode === undefined ? "" : ` exit=${snapshot.exitCode ?? "none"}`;
			const stopping = snapshot.killRequested && !snapshot.settled ? " stopping" : "";
			return `${snapshot.id} [${snapshot.status}${stopping}] ${cleanInline(snapshot.title)} • ${formatDuration(elapsed)}${exit} • ${formatSize(snapshot.output.totalBytes)} • ${cleanInline(snapshot.cwd)}`;
		});
	if (omitted > 0) lines.unshift(`${omitted} older background processes omitted. Showing the ${visible.length} most recent.`);
	return lines.join("\n");
}

export function recentListSnapshots(snapshots: BackgroundProcessSnapshot[]): BackgroundProcessSnapshot[] {
	return snapshots.slice(-LIST_MAX_ENTRIES);
}

export function formatWaitResult(result: WaitResult): string {
	const parts: string[] = [];
	let remaining = WAIT_TOTAL_BYTES;
	for (const snapshot of result.settled) {
		if (remaining <= 0) break;
		const budget = { maxBytes: Math.max(1024, Math.min(WAIT_ENTRY_BUDGET.maxBytes, remaining)), maxLines: WAIT_ENTRY_BUDGET.maxLines };
		const formatted = formatProcess(snapshot, budget);
		const bounded = truncateTail(formatted, budget).content;
		parts.push(bounded);
		remaining = Math.max(0, remaining - Buffer.byteLength(bounded, "utf8"));
		if (remaining === 0) break;
	}
	if (result.timedOut) {
		parts.push(`Wait timed out. Still running: ${result.runningIds.join(", ") || "none"}.`);
	} else {
		parts.push("All requested background processes settled.");
	}
	return truncateTail(parts.join("\n\n---\n\n"), { maxBytes: WAIT_TOTAL_BYTES, maxLines: 1000 }).content;
}

export function formatKillResults(results: KillResultItem[]): string {
	return results
		.map(({ id, outcome, snapshot }) => {
			const detail =
				outcome === "already-settled"
					? `already settled as ${snapshot.status}`
					: outcome === "settled-after-request"
						? `settled naturally as ${snapshot.status} after termination was requested`
						: outcome === "termination-pending"
							? "termination requested but settlement was not observed before the deadline"
							: `termination observed (${snapshot.status})`;
			return `${id} (${cleanInline(snapshot.title)}): ${detail}`;
		})
		.join("\n");
}

export function formatAutomaticResults(snapshots: BackgroundProcessSnapshot[]): string {
	const header = snapshots.length === 1 ? "A background process finished." : `${snapshots.length} background processes finished.`;
	const full = [header, ...snapshots.map((snapshot) => formatProcess(snapshot, AUTO_BUDGET))].join("\n\n---\n\n");
	return truncateTail(full, AUTO_BUDGET).content;
}

export function cleanInline(text: string): string {
	return sanitizeTerminalText(text).replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function formatPreciseDuration(milliseconds: number): string {
	return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}
