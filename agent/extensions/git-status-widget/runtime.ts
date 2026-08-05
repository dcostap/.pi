import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectGitSnapshot, isAbortError, type GitSnapshot } from "./git.ts";

export const WIDGET_ID = "git-status-widget";
export const EVENT_REFRESH_DELAY_MS = 500;
export const MIN_FALLBACK_DELAY_MS = 30_000;
export const MAX_FALLBACK_DELAY_MS = 60_000;

const GRAY = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

type TimerHandle = ReturnType<typeof setTimeout>;

export type RuntimeDependencies = {
	collectSnapshot: typeof collectGitSnapshot;
	now: () => number;
	setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
};

const defaultDependencies: RuntimeDependencies = {
	collectSnapshot: collectGitSnapshot,
	now: Date.now,
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer),
};

export function fallbackDelayMs(snapshot: GitSnapshot, cleanStreak: number) {
	const scanAdjusted = Math.max(MIN_FALLBACK_DELAY_MS, snapshot.durationMs * 10);
	const completedCleanIntervals = Math.max(0, cleanStreak - 1);
	const cleanMultiplier = snapshot.changeCount === 0 ? 1 + Math.min(completedCleanIntervals, 2) * 0.5 : 1;
	return Math.min(MAX_FALLBACK_DELAY_MS, Math.round(scanAdjusted * cleanMultiplier));
}

function countLabel(count: number, label: string) {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function formatSnapshot(snapshot: GitSnapshot) {
	const parts = [`${GRAY} ${snapshot.branch}`];
	if (snapshot.conflictedCount > 0) parts.push(countLabel(snapshot.conflictedCount, "conflict"));
	if (snapshot.stagedCount > 0) parts.push(`${snapshot.stagedCount} staged`);
	parts.push(`${snapshot.unstagedCount} unstaged ${snapshot.unstagedCount === 1 ? "file" : "files"}`);
	const addedPrefix = snapshot.lineStatsComplete ? "+" : "~+";
	const added = `${snapshot.added > 0 ? GREEN : GRAY}${addedPrefix}${snapshot.added}`;
	const removed = `${snapshot.removed > 0 ? RED : GRAY}-${snapshot.removed}${RESET}`;
	parts.push(`${added}${GRAY} ${removed}`);
	return parts.join(` ${GRAY}· `);
}

export class GitStatusWidgetRuntime {
	private enabled = true;
	private disposed = false;
	private agentRunning = false;
	private refreshAfterSettle = false;
	private timer: { handle: TimerHandle; dueAt: number } | undefined;
	private inFlight: AbortController | undefined;
	private pendingDelayMs: number | undefined;
	private cleanStreak = 0;
	private lastWidgetSignature: string | undefined;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly dependencies: RuntimeDependencies = defaultDependencies,
	) {}

	start() {
		this.requestRefresh(0);
	}

	isEnabled() {
		return this.enabled;
	}

	setEnabled(enabled: boolean) {
		if (this.disposed || this.enabled === enabled) return;
		this.enabled = enabled;
		if (!enabled) {
			this.stopWork();
			return;
		}
		this.cleanStreak = 0;
		this.requestRefresh(0);
	}

	onAgentStart() {
		this.agentRunning = true;
	}

	onUserInput() {
		if (this.enabled && !this.disposed) this.refreshAfterSettle = true;
	}

	onWorkingTreeMutation() {
		if (this.enabled && !this.disposed) this.refreshAfterSettle = true;
	}

	onAgentSettled() {
		this.agentRunning = false;
		if (this.refreshAfterSettle || this.pendingDelayMs !== undefined) {
			this.refreshAfterSettle = false;
			this.requestRefresh(EVENT_REFRESH_DELAY_MS);
		}
	}

	refreshNow() {
		if (this.disposed || !this.enabled) return false;
		this.requestRefresh(0);
		return true;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		this.stopWork();
	}

	private requestRefresh(delayMs: number) {
		if (this.disposed || !this.enabled) return;
		if (this.inFlight) {
			this.pendingDelayMs = Math.min(this.pendingDelayMs ?? Number.POSITIVE_INFINITY, delayMs);
			return;
		}

		const normalizedDelay = Math.max(0, delayMs);
		const dueAt = this.dependencies.now() + normalizedDelay;
		if (this.timer && this.timer.dueAt <= dueAt) return;
		this.cancelTimer();
		const handle = this.dependencies.setTimer(() => {
			this.timer = undefined;
			if (this.agentRunning) {
				this.refreshAfterSettle = true;
				return;
			}
			void this.runRefresh();
		}, normalizedDelay);
		this.timer = { handle, dueAt };
	}

	private async runRefresh() {
		if (this.disposed || !this.enabled || this.inFlight) return;
		const controller = new AbortController();
		this.inFlight = controller;
		try {
			const snapshot = await this.dependencies.collectSnapshot(this.ctx.cwd, {
				signal: controller.signal,
			});
			if (this.disposed || !this.enabled || controller.signal.aborted) return;
			this.cleanStreak = snapshot.changeCount === 0 ? this.cleanStreak + 1 : 0;
			this.setWidget(formatSnapshot(snapshot));
			this.requestRefresh(fallbackDelayMs(snapshot, this.cleanStreak));
		} catch (error) {
			if (!isAbortError(error) && !this.disposed && this.enabled) {
				this.requestRefresh(MAX_FALLBACK_DELAY_MS);
			}
		} finally {
			if (this.inFlight === controller) this.inFlight = undefined;
			if (this.disposed || !this.enabled) return;
			if (this.pendingDelayMs !== undefined) {
				const delay = this.pendingDelayMs;
				this.pendingDelayMs = undefined;
				this.requestRefresh(delay);
			}
		}
	}

	private setWidget(text: string) {
		if (this.lastWidgetSignature === text) return;
		try {
			this.ctx.ui.setWidget(WIDGET_ID, [text]);
			this.lastWidgetSignature = text;
		} catch {
			// Session replacement can stale a context before its shutdown event finishes.
		}
	}

	private clearWidget() {
		if (this.lastWidgetSignature === undefined) return;
		try {
			this.ctx.ui.setWidget(WIDGET_ID, undefined);
		} catch {
			// Session replacement can stale a context before its shutdown event finishes.
		}
		this.lastWidgetSignature = undefined;
	}

	private cancelTimer() {
		if (this.timer) this.dependencies.clearTimer(this.timer.handle);
		this.timer = undefined;
	}

	private stopWork() {
		this.cancelTimer();
		this.pendingDelayMs = undefined;
		this.refreshAfterSettle = false;
		this.inFlight?.abort();
		this.clearWidget();
	}
}
