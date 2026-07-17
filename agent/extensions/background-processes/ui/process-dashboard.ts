import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { BackgroundProcessManager, BackgroundProcessSnapshot, ManagerEvent } from "../manager.ts";
import { cleanInline, formatDuration } from "../formatting.ts";
import { getOutputWindow } from "./output-view.ts";

export class ProcessDashboard {
	private mode: "list" | "detail" = "list";
	private selectedId: string | undefined;
	private scrollFromBottom = 0;
	private unsubscribe: (() => void) | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private elapsedTimer: ReturnType<typeof setInterval> | undefined;
	private lastRefreshAt = 0;
	private killing = new Set<string>();
	private closed = false;

	constructor(
		private readonly manager: BackgroundProcessManager,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly done: () => void,
	) {
		this.syncSelection();
		this.unsubscribe = manager.subscribe((event) => this.onManagerEvent(event));
		this.elapsedTimer = setInterval(() => {
			if (!this.closed) this.requestRender();
		}, 1000);
	}

	handleInput(data: string): void {
		if (this.isCancel(data)) {
			if (this.mode === "detail") {
				this.mode = "list";
				this.scrollFromBottom = 0;
				this.requestRender();
			} else {
				this.close();
			}
			return;
		}

		if (data === "x" || data === "X") {
			this.killSelected();
			return;
		}

		if (this.mode === "list") {
			if (this.isUp(data)) this.moveSelection(-1);
			else if (this.isDown(data)) this.moveSelection(1);
			else if (this.isConfirm(data)) {
				if (this.selectedId) {
					this.mode = "detail";
					this.scrollFromBottom = 0;
					this.requestRender();
				}
			}
			return;
		}

		if (this.isUp(data)) {
			this.scrollFromBottom++;
			this.requestRender();
		} else if (this.isDown(data)) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollFromBottom += 8;
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 8);
			this.requestRender();
		}
	}

	render(width: number): string[] {
		this.syncSelection();
		return this.mode === "detail" ? this.renderDetail(width) : this.renderList(width);
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		if (this.elapsedTimer) clearInterval(this.elapsedTimer);
		this.elapsedTimer = undefined;
	}

	private renderList(width: number): string[] {
		const snapshots = this.manager.list();
		const lines = [
			this.fit(this.theme.fg("accent", this.theme.bold("Background Processes")), width),
			this.fit(this.theme.fg("dim", "Enter details • x stop • Esc close"), width),
			"",
		];
		if (snapshots.length === 0) {
			lines.push(this.theme.fg("muted", "No background processes are tracked."));
			return lines;
		}

		const selectedIndex = Math.max(0, snapshots.findIndex((entry) => entry.id === this.selectedId));
		const visibleRows = 10;
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), snapshots.length - visibleRows));
		for (const snapshot of snapshots.slice(start, start + visibleRows)) {
			const selected = snapshot.id === this.selectedId;
			const marker = selected ? "▶" : " ";
			const state = this.coloredState(snapshot);
			const elapsed = formatDuration((snapshot.settledAt ?? Date.now()) - snapshot.createdAt);
			const row = `${marker} ${snapshot.id.padEnd(6)} ${state.padEnd(12)} ${cleanInline(snapshot.title)} • ${elapsed} • ${formatSize(snapshot.output.totalBytes)}`;
			lines.push(this.fit(row, width));
			if (selected) lines.push(this.fit(this.theme.fg("dim", `    ${cleanInline(snapshot.cwd)}`), width));
		}
		return lines;
	}

	private renderDetail(width: number): string[] {
		const snapshot = this.selectedId ? this.manager.list().find((entry) => entry.id === this.selectedId) : undefined;
		if (!snapshot) {
			this.mode = "list";
			return this.renderList(width);
		}

		const innerWidth = Math.max(1, width - 2);
		const output = getOutputWindow(snapshot, innerWidth, 10, this.scrollFromBottom);
		this.scrollFromBottom = output.scrollFromBottom;
		const elapsed = formatDuration((snapshot.settledAt ?? Date.now()) - snapshot.createdAt);
		const lines = [
			this.fit(`${this.theme.fg("accent", this.theme.bold(snapshot.id))} — ${cleanInline(snapshot.title)}`, width),
			this.fit(`${this.coloredState(snapshot)} • ${elapsed}${snapshot.exitCode === undefined ? "" : ` • exit ${snapshot.exitCode ?? "none"}`}`, width),
			this.fit(this.theme.fg("dim", cleanInline(snapshot.cwd)), width),
			this.fit(this.theme.fg("muted", cleanInline(snapshot.command)), width),
			"",
			this.fit(this.theme.fg("accent", `Output (${formatSize(snapshot.output.totalBytes)} captured)`), width),
		];
		for (const line of output.lines) lines.push(this.fit(`  ${this.theme.fg("text", line)}`, width));
		if (snapshot.output.truncated) {
			lines.push(this.fit(this.theme.fg("warning", `Oldest ${formatSize(snapshot.output.droppedBytes)} discarded.`), width));
		}
		if (output.maxScrollFromBottom > 0) {
			lines.push(this.fit(this.theme.fg("dim", `Scroll ${output.scrollFromBottom}/${output.maxScrollFromBottom} lines from newest.`), width));
		}
		lines.push("", this.fit(this.theme.fg("dim", "↑↓ scroll • x stop • Esc back"), width));
		return lines;
	}

	private coloredState(snapshot: BackgroundProcessSnapshot): string {
		if (this.killing.has(snapshot.id) || (snapshot.killRequested && !snapshot.settled)) return this.theme.fg("warning", "stopping");
		if (snapshot.status === "running") return this.theme.fg("accent", "running");
		if (snapshot.status === "done") return this.theme.fg("success", "done");
		if (snapshot.status === "killed") return this.theme.fg("warning", "killed");
		return this.theme.fg("error", "failed");
	}

	private moveSelection(delta: number): void {
		const snapshots = this.manager.list();
		if (snapshots.length === 0) return;
		const index = Math.max(0, snapshots.findIndex((entry) => entry.id === this.selectedId));
		const next = Math.max(0, Math.min(snapshots.length - 1, index + delta));
		this.selectedId = snapshots[next]!.id;
		this.requestRender();
	}

	private killSelected(): void {
		const id = this.selectedId;
		if (!id) return;
		let snapshot: BackgroundProcessSnapshot;
		try {
			snapshot = this.manager.get(id);
		} catch {
			return;
		}
		if (snapshot.settled || this.killing.has(id)) return;
		this.killing.add(id);
		this.requestRender();
		void this.manager
			.kill([id])
			.catch(() => {})
			.finally(() => {
				this.killing.delete(id);
				if (!this.closed) this.requestRender();
			});
	}

	private syncSelection(): void {
		const snapshots = this.manager.list();
		if (snapshots.length === 0) {
			this.selectedId = undefined;
			return;
		}
		if (!this.selectedId || !snapshots.some((entry) => entry.id === this.selectedId)) {
			this.selectedId = snapshots.at(-1)!.id;
		}
	}

	private onManagerEvent(event: ManagerEvent): void {
		if (event.kind === "disposing") {
			this.close();
			return;
		}
		const elapsed = Date.now() - this.lastRefreshAt;
		if (elapsed >= 250) {
			this.lastRefreshAt = Date.now();
			this.requestRender();
			return;
		}
		if (!this.refreshTimer) {
			this.refreshTimer = setTimeout(() => {
				this.refreshTimer = undefined;
				this.lastRefreshAt = Date.now();
				if (!this.closed) this.requestRender();
			}, 250 - elapsed);
		}
	}

	private isUp(data: string): boolean {
		return data === "k" || data === "K" || this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up");
	}

	private isDown(data: string): boolean {
		return data === "j" || data === "J" || this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down");
	}

	private isConfirm(data: string): boolean {
		return this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "return");
	}

	private isCancel(data: string): boolean {
		return this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, Math.max(1, width), "…");
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
	}
}
