import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundProcessManager, BackgroundProcessSnapshot, ManagerEvent } from "../manager.ts";
import { cleanInline, formatDuration } from "../formatting.ts";
import { getOutputWindow } from "./output-view.ts";

type Notice = { kind: "warning" | "error" | "success"; text: string };

export class ProcessDashboard {
	private mode: "list" | "detail" = "list";
	private selectedId: string | undefined;
	private scrollFromBottom = 0;
	private unsubscribe: (() => void) | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private elapsedTimer: ReturnType<typeof setInterval> | undefined;
	private killConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRefreshAt = 0;
	private killing = new Set<string>();
	private killConfirmId: string | undefined;
	private notice: Notice | undefined;
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
			this.clearKillConfirmation();
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
			this.requestKillSelected();
			return;
		}

		if (this.mode === "list") {
			if (this.isUp(data)) this.moveSelection(-1);
			else if (this.isDown(data)) this.moveSelection(1);
			else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveSelection(-this.listPageSize());
			else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveSelection(this.listPageSize());
			else if (matchesKey(data, "home")) this.selectEdge("first");
			else if (matchesKey(data, "end")) this.selectEdge("last");
			else if (this.isConfirm(data) && this.selectedId) {
				this.clearKillConfirmation();
				this.mode = "detail";
				this.scrollFromBottom = 0;
				this.requestRender();
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
			this.scrollFromBottom += this.detailOutputHeight();
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - this.detailOutputHeight());
			this.requestRender();
		} else if (matchesKey(data, "home")) {
			this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
			this.requestRender();
		} else if (matchesKey(data, "end") || data === "g" || data === "G") {
			this.scrollFromBottom = 0;
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
		this.clearKillConfirmation(false);
	}

	private renderList(width: number): string[] {
		const snapshots = this.manager.list();
		if (width < 4) return [this.fit("ps", width)];

		const innerWidth = width - 2;
		const lines: string[] = [this.topBorder("Background Processes", width)];
		lines.push(this.frame(this.renderSummary(snapshots, innerWidth), innerWidth));
		lines.push(this.separator(width));

		if (snapshots.length === 0) {
			lines.push(this.frame(this.theme.fg("muted", "No processes are tracked in this session."), innerWidth));
			lines.push(this.frame(this.theme.fg("dim", "Long-running bash jobs will appear here automatically."), innerWidth));
			lines.push(this.separator(width));
			lines.push(this.frame(this.theme.fg("dim", "Esc close"), innerWidth));
			lines.push(this.bottomBorder(width));
			return lines;
		}

		const selectedIndex = Math.max(0, snapshots.findIndex((entry) => entry.id === this.selectedId));
		const visibleRows = this.listPageSize();
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), snapshots.length - visibleRows));
		const visible = snapshots.slice(start, start + visibleRows);

		lines.push(this.frame(this.renderListHeader(innerWidth), innerWidth));
		lines.push(this.separator(width, "dim"));
		for (const snapshot of visible) {
			const selected = snapshot.id === this.selectedId;
			const content = this.pad(this.renderProcessRow(snapshot, selected, innerWidth), innerWidth);
			lines.push(this.frame(selected ? this.theme.bg("selectedBg", content) : content, innerWidth, true));
		}

		if (snapshots.length > visibleRows) {
			const range = `${start + 1}–${start + visible.length} of ${snapshots.length}`;
			lines.push(this.frame(this.theme.fg("dim", this.alignRight(range, innerWidth)), innerWidth, true));
		}

		const selected = snapshots[selectedIndex];
		lines.push(this.separator(width));
		if (selected) {
			lines.push(this.frame(`${this.theme.fg("muted", "cwd")}  ${this.theme.fg("text", cleanInline(selected.cwd))}`, innerWidth));
			lines.push(this.frame(`${this.theme.fg("muted", "cmd")}  ${this.theme.fg("text", cleanInline(selected.command))}`, innerWidth));
		}
		lines.push(this.separator(width));
		lines.push(this.frame(this.renderFooter("list"), innerWidth));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const snapshot = this.selectedId ? this.manager.list().find((entry) => entry.id === this.selectedId) : undefined;
		if (!snapshot) {
			this.mode = "list";
			return this.renderList(width);
		}
		if (width < 4) return [this.fit(snapshot.id, width)];

		const innerWidth = width - 2;
		const outputHeight = this.detailOutputHeight();
		const output = getOutputWindow(snapshot, innerWidth, outputHeight, this.scrollFromBottom);
		this.scrollFromBottom = output.scrollFromBottom;
		const elapsed = formatDuration((snapshot.settledAt ?? Date.now()) - snapshot.createdAt);
		const exit = snapshot.exitCode === undefined ? "" : `  ${this.theme.fg("muted", "exit")} ${snapshot.exitCode ?? "none"}`;
		const lines = [
			this.topBorder(`${snapshot.id} · ${cleanInline(snapshot.title)}`, width),
			this.frame(`${this.stateBadge(snapshot)}  ${this.theme.fg("muted", snapshot.settled ? "took" : "elapsed")} ${elapsed}${exit}`, innerWidth),
			this.frame(`${this.theme.fg("muted", "cwd")}  ${this.theme.fg("text", cleanInline(snapshot.cwd))}`, innerWidth),
			this.frame(`${this.theme.fg("muted", "cmd")}  ${this.theme.fg("text", cleanInline(snapshot.command))}`, innerWidth),
		];
		if (snapshot.errorText) {
			lines.push(this.frame(`${this.theme.fg("error", "error")}  ${this.theme.fg("error", cleanInline(snapshot.errorText))}`, innerWidth));
		}
		lines.push(this.separator(width));

		const live = snapshot.status === "running" && output.scrollFromBottom === 0;
		const outputLabel = `Output · ${formatSize(snapshot.output.totalBytes)}`;
		const outputMode = live
			? this.theme.fg("success", "● live")
			: output.maxScrollFromBottom > 0
				? this.theme.fg("muted", `${output.scrollFromBottom} lines from newest`)
				: this.theme.fg("dim", snapshot.settled ? "complete" : "waiting");
		lines.push(this.frame(`${this.theme.fg("accent", this.theme.bold(outputLabel))}  ${outputMode}`, innerWidth));
		for (const line of output.lines) lines.push(this.frame(this.theme.fg("text", line), innerWidth));
		for (let index = output.lines.length; index < outputHeight; index++) lines.push(this.frame("", innerWidth));

		const outputNotes: string[] = [];
		if (snapshot.output.truncated) outputNotes.push(`${formatSize(snapshot.output.droppedBytes)} oldest output discarded`);
		if (snapshot.output.fullOutputPath) outputNotes.push(`full output: ${cleanInline(snapshot.output.fullOutputPath)}`);
		if (snapshot.output.fileError) outputNotes.push(`save error: ${cleanInline(snapshot.output.fileError)}`);
		lines.push(this.frame(this.theme.fg(outputNotes.length > 0 ? "warning" : "dim", outputNotes.join(" • ") || "End jumps to newest output"), innerWidth));
		lines.push(this.separator(width));
		lines.push(this.frame(this.renderFooter("detail"), innerWidth));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private renderSummary(snapshots: BackgroundProcessSnapshot[], width: number): string {
		const running = snapshots.filter((snapshot) => !snapshot.settled).length;
		const done = snapshots.filter((snapshot) => snapshot.status === "done").length;
		const problems = snapshots.filter((snapshot) => snapshot.status === "failed" || snapshot.status === "killed").length;
		const totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.output.totalBytes, 0);
		const parts = [
			running > 0 ? this.theme.fg("accent", `● ${running} running`) : this.theme.fg("dim", "○ idle"),
			done > 0 ? this.theme.fg("success", `✓ ${done} done`) : "",
			problems > 0 ? this.theme.fg("warning", `! ${problems} stopped/failed`) : "",
			this.theme.fg("muted", `${snapshots.length} tracked · ${formatSize(totalBytes)} captured`),
		].filter(Boolean);
		return this.fit(parts.join("  "), width);
	}

	private renderListHeader(width: number): string {
		if (width >= 70) return this.columns(width, "", "STATE", "ID", "TITLE", "TIME", "OUTPUT");
		if (width >= 50) return this.columns(width, "", "STATE", "ID", "TITLE", "TIME");
		return this.fit("   PROCESS", width);
	}

	private renderProcessRow(snapshot: BackgroundProcessSnapshot, selected: boolean, width: number): string {
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const state = this.stateBadge(snapshot);
		const elapsed = formatDuration((snapshot.settledAt ?? Date.now()) - snapshot.createdAt);
		const title = cleanInline(snapshot.title);
		if (width >= 70) return this.columns(width, marker, state, snapshot.id, title, elapsed, formatSize(snapshot.output.totalBytes));
		if (width >= 50) return this.columns(width, marker, state, snapshot.id, title, elapsed);
		return this.fit(`${marker} ${this.stateGlyph(snapshot)} ${title} · ${elapsed}`, width);
	}

	private columns(width: number, marker: string, state: string, id: string, title: string, elapsed: string, output?: string): string {
		const markerWidth = 2;
		const stateWidth = 11;
		const idWidth = 8;
		const elapsedWidth = 8;
		const outputWidth = output === undefined ? 0 : 10;
		const titleWidth = Math.max(6, width - markerWidth - stateWidth - idWidth - elapsedWidth - outputWidth);
		return [
			this.pad(marker, markerWidth),
			this.pad(state, stateWidth),
			this.pad(id, idWidth),
			this.pad(title, titleWidth),
			this.pad(elapsed, elapsedWidth),
			...(output === undefined ? [] : [this.alignRight(output, outputWidth)]),
		].join("");
	}

	private stateBadge(snapshot: BackgroundProcessSnapshot): string {
		const state = this.stateLabel(snapshot);
		return `${this.stateGlyph(snapshot)} ${state}`;
	}

	private stateGlyph(snapshot: BackgroundProcessSnapshot): string {
		if (this.killing.has(snapshot.id) || (snapshot.killRequested && !snapshot.settled)) return this.theme.fg("warning", "◐");
		if (snapshot.status === "running") return this.theme.fg("accent", "●");
		if (snapshot.status === "done") return this.theme.fg("success", "✓");
		if (snapshot.status === "killed") return this.theme.fg("warning", "■");
		return this.theme.fg("error", "✕");
	}

	private stateLabel(snapshot: BackgroundProcessSnapshot): string {
		if (this.killing.has(snapshot.id) || (snapshot.killRequested && !snapshot.settled)) return this.theme.fg("warning", "stopping");
		if (snapshot.status === "running") return this.theme.fg("accent", "running");
		if (snapshot.status === "done") return this.theme.fg("success", "done");
		if (snapshot.status === "killed") return this.theme.fg("warning", "killed");
		return this.theme.fg("error", "failed");
	}

	private renderFooter(mode: "list" | "detail"): string {
		if (this.notice) return this.theme.fg(this.notice.kind, this.notice.text);
		if (this.killConfirmId === this.selectedId) {
			return this.theme.fg("warning", `Stop ${this.selectedId}? Press x again to confirm · Esc cancels`);
		}
		return mode === "list"
			? this.theme.fg("dim", "↑↓/jk select · PgUp/PgDn jump · Enter inspect · x stop · Esc close")
			: this.theme.fg("dim", "↑↓/jk scroll · PgUp/PgDn jump · End/G newest · x stop · Esc back");
	}

	private moveSelection(delta: number): void {
		const snapshots = this.manager.list();
		if (snapshots.length === 0) return;
		const index = Math.max(0, snapshots.findIndex((entry) => entry.id === this.selectedId));
		const next = Math.max(0, Math.min(snapshots.length - 1, index + delta));
		if (next === index) return;
		this.selectedId = snapshots[next]!.id;
		this.notice = undefined;
		this.clearKillConfirmation(false);
		this.requestRender();
	}

	private selectEdge(edge: "first" | "last"): void {
		const snapshots = this.manager.list();
		const snapshot = edge === "first" ? snapshots[0] : snapshots.at(-1);
		if (!snapshot) return;
		this.selectedId = snapshot.id;
		this.notice = undefined;
		this.clearKillConfirmation(false);
		this.requestRender();
	}

	private requestKillSelected(): void {
		const id = this.selectedId;
		if (!id) return;
		let snapshot: BackgroundProcessSnapshot;
		try {
			snapshot = this.manager.get(id);
		} catch {
			return;
		}
		if (snapshot.settled || this.killing.has(id)) {
			this.notice = { kind: "warning", text: `${id} is not running.` };
			this.requestRender();
			return;
		}
		if (this.killConfirmId !== id) {
			this.notice = undefined;
			this.clearKillConfirmation(false);
			this.killConfirmId = id;
			this.killConfirmTimer = setTimeout(() => {
				this.killConfirmTimer = undefined;
				this.killConfirmId = undefined;
				if (!this.closed) this.requestRender();
			}, 3000);
			this.requestRender();
			return;
		}

		this.clearKillConfirmation(false);
		this.killing.add(id);
		this.notice = { kind: "warning", text: `Stopping ${id}…` };
		this.requestRender();
		void this.manager
			.kill([id])
			.then(() => {
				this.notice = { kind: "success", text: `Stop requested for ${id}.` };
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.notice = { kind: "error", text: `Could not stop ${id}: ${cleanInline(message)}` };
			})
			.finally(() => {
				this.killing.delete(id);
				if (!this.closed) this.requestRender();
			});
	}

	private clearKillConfirmation(render = true): void {
		if (this.killConfirmTimer) clearTimeout(this.killConfirmTimer);
		this.killConfirmTimer = undefined;
		const changed = this.killConfirmId !== undefined;
		this.killConfirmId = undefined;
		if (changed && render && !this.closed) this.requestRender();
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

	private listPageSize(): number {
		return Math.max(3, Math.min(12, Math.floor((process.stdout.rows ?? 28) * 0.85) - 12));
	}

	private detailOutputHeight(): number {
		return Math.max(4, Math.min(14, Math.floor((process.stdout.rows ?? 28) * 0.85) - 11));
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

	private topBorder(title: string, width: number): string {
		const innerWidth = Math.max(1, width - 2);
		const label = truncateToWidth(` ${title} `, innerWidth, "");
		const remaining = Math.max(0, innerWidth - visibleWidth(label));
		const left = Math.min(2, remaining);
		return this.fit(
			this.theme.fg("border", `╭${"─".repeat(left)}`) +
				this.theme.fg("accent", this.theme.bold(label)) +
				this.theme.fg("border", `${"─".repeat(remaining - left)}╮`),
			width,
		);
	}

	private separator(width: number, color: "border" | "dim" = "border"): string {
		return this.theme.fg(color, `├${"─".repeat(Math.max(1, width - 2))}┤`);
	}

	private bottomBorder(width: number): string {
		return this.theme.fg("border", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
	}

	private frame(text: string, innerWidth: number, alreadyPadded = false): string {
		const content = alreadyPadded ? this.fit(text, innerWidth) : this.pad(text, innerWidth);
		return this.theme.fg("border", "│") + content + this.theme.fg("border", "│");
	}

	private pad(text: string, width: number): string {
		const fitted = this.fit(text, width);
		return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	}

	private alignRight(text: string, width: number): string {
		const fitted = this.fit(text, width);
		return " ".repeat(Math.max(0, width - visibleWidth(fitted))) + fitted;
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
