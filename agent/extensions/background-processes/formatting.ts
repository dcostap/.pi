import { formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import type { BackgroundProcessSnapshot, KillResultItem, WaitResult } from "./manager.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

export interface OutputBudget {
	maxBytes: number;
	maxLines: number;
}

export const STATUS_BUDGET: OutputBudget = { maxBytes: 24 * 1024, maxLines: 400 };
export const AUTO_BUDGET: OutputBudget = { maxBytes: 12 * 1024, maxLines: 80 };
export const WAIT_ENTRY_BUDGET: OutputBudget = { maxBytes: 16 * 1024, maxLines: 250 };
export const WAIT_TOTAL_BYTES = 48 * 1024;

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
		`Started ${snapshot.id}: ${cleanInline(snapshot.title)}`,
		`Working directory: ${cleanInline(snapshot.cwd)}`,
		`Command: ${sanitizeTerminalText(snapshot.command)}`,
		"Use bash_bg_wait only when further work depends on completion; otherwise continue useful work.",
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

export function formatList(snapshots: BackgroundProcessSnapshot[], now = Date.now()): string {
	if (snapshots.length === 0) return "No background processes are tracked.";
	return snapshots
		.map((snapshot) => {
			const elapsed = (snapshot.settledAt ?? now) - snapshot.createdAt;
			const exit = snapshot.exitCode === undefined ? "" : ` exit=${snapshot.exitCode ?? "none"}`;
			const stopping = snapshot.killRequested && !snapshot.settled ? " stopping" : "";
			return `${snapshot.id} [${snapshot.status}${stopping}] ${cleanInline(snapshot.title)} • ${formatDuration(elapsed)}${exit} • ${formatSize(snapshot.output.totalBytes)} • ${cleanInline(snapshot.cwd)}`;
		})
		.join("\n");
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
			return `${id}: ${detail}`;
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
