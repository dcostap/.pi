import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getCurrentTaskId } from "./state.ts";
import type { TodoItem, TodoState } from "./types.ts";

export type DashboardAction =
	| { type: "close" }
	| { type: "clear_current" }
	| { type: "add_task" | "add_watch" }
	| { type: "inspect" | "edit" | "delete" | "group" | "schedule" | "run" | "toggle" | "set_current" | "move_up" | "move_down"; id: string };

type DashboardView = "active" | "completed" | "all";

const DASHBOARD_VIEWS: DashboardView[] = ["active", "completed", "all"];

export class TodoDashboard {
	private selected = 0;
	private closed = false;
	private view: DashboardView;

	constructor(
		private readonly state: TodoState,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (action: DashboardAction) => void,
	) {
		this.view = state.items.some((item) => item.kind === "watch" || !item.done) ? "active" : "completed";
		const currentTaskId = getCurrentTaskId(state);
		const currentIndex = this.visibleItems().findIndex((item) => item.id === currentTaskId);
		if (currentIndex >= 0) this.selected = currentIndex;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.cycleView();
			return;
		}
		if (data === "1" || data === "2" || data === "3") {
			this.setView(DASHBOARD_VIEWS[Number(data) - 1]!);
			return;
		}
		const items = this.visibleItems();
		if (this.isCancel(data) || data === "q" || data === "Q") return this.close({ type: "close" });
		if (data === "a" || data === "A") return this.close({ type: "add_task" });
		if (data === "w" || data === "W") return this.close({ type: "add_watch" });
		if (this.isUp(data)) this.selected = Math.max(0, this.selected - 1);
		else if (this.isDown(data)) this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
		else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = Math.max(0, items.length - 1);
		else {
			const item = items[this.selected];
			if (!item) return;
			if (data === " " && item.kind === "task") return this.close({ type: "toggle", id: item.id });
			if (this.isConfirm(data) || data === "v" || data === "V") return this.close({ type: "inspect", id: item.id });
			if (data === "e" || data === "E") return this.close({ type: "edit", id: item.id });
			if (data === "d" || data === "D") return this.close({ type: "delete", id: item.id });
			if (data === "g" || data === "G") return this.close({ type: "group", id: item.id });
			if ((data === "f" || data === "F") && item.kind === "task" && !item.done) {
				return this.close(item.id === getCurrentTaskId(this.state) ? { type: "clear_current" } : { type: "set_current", id: item.id });
			}
			if (data === "s" || data === "S") return this.close({ type: "schedule", id: item.id });
			if (data === "r" || data === "R") return this.close({ type: "run", id: item.id });
			if (data === "K") return this.close({ type: "move_up", id: item.id });
			if (data === "J") return this.close({ type: "move_down", id: item.id });
		}
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const items = this.visibleItems();
		const tasks = this.state.items.filter((item) => item.kind === "task");
		const done = tasks.filter((item) => item.done).length;
		const watches = this.state.items.filter((item) => item.kind === "watch").length;
		const currentTaskId = getCurrentTaskId(this.state);
		const lines = [
			this.border("Todos", width, "top"),
			this.frame(`${this.theme.fg("muted", `${done}/${tasks.length} tasks done · ${watches} watches · current ${currentTaskId ?? "none"} · scripts ${this.state.scriptsEnabled ? "on" : "off"}`)}`, inner),
			this.frame(this.renderViewTabs(), inner),
			this.separator(width),
		];
		if (items.length === 0) {
			const message = this.state.items.length === 0
				? "No items. Press a to add a task or w to add a watch."
				: `No ${this.view} items. Press Tab to change the view.`;
			lines.push(this.frame(this.theme.fg("dim", message), inner));
		} else {
			const pageSize = this.listPageSize();
			const start = Math.max(0, Math.min(this.selected - Math.floor(pageSize / 2), items.length - pageSize));
			const visible = items.slice(start, start + pageSize);
			let group: string | undefined | null = null;
			for (const [offset, item] of visible.entries()) {
				const index = start + offset;
				if (item.group !== group) {
					group = item.group;
					if (group) lines.push(this.frame(this.theme.fg("accent", this.theme.bold(group)), inner));
				}
				const row = this.renderItem(item, index === this.selected, inner);
				lines.push(this.frame(index === this.selected ? this.theme.bg("selectedBg", this.pad(row, inner)) : row, inner, index === this.selected));
			}
			if (items.length > visible.length) {
				lines.push(this.frame(this.theme.fg("dim", `${start + 1}–${start + visible.length} of ${items.length}`), inner));
			}
		}
		lines.push(this.separator(width));
		lines.push(this.frame(this.theme.fg("dim", "Tab/1–3 view · ↑↓/jk select · Enter inspect · e edit · Space check"), inner));
		lines.push(this.frame(this.theme.fg("dim", "a task · w watch · f set/clear current · g group · r run · d delete"), inner));
		lines.push(this.frame(this.theme.fg("dim", "Shift+J/K move · Esc close"), inner));
		lines.push(this.border("", width, "bottom"));
		return lines;
	}

	invalidate(): void {}

	private visibleItems(): TodoItem[] {
		if (this.view === "active") return this.state.items.filter((item) => item.kind === "watch" || !item.done);
		if (this.view === "completed") {
			return this.state.items
				.filter((item) => item.kind === "task" && item.done)
				.sort((left, right) => (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt));
		}
		return this.state.items;
	}

	private renderViewTabs(): string {
		return DASHBOARD_VIEWS.map((view, index) => {
			const label = `${index + 1} ${view[0]!.toUpperCase()}${view.slice(1)}`;
			return view === this.view
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("dim", ` ${label} `);
		}).join("  ");
	}

	private cycleView(): void {
		const index = DASHBOARD_VIEWS.indexOf(this.view);
		this.setView(DASHBOARD_VIEWS[(index + 1) % DASHBOARD_VIEWS.length]!);
	}

	private setView(view: DashboardView): void {
		this.view = view;
		this.selected = 0;
		const currentTaskId = getCurrentTaskId(this.state);
		const currentIndex = this.visibleItems().findIndex((item) => item.id === currentTaskId);
		if (currentIndex >= 0) this.selected = currentIndex;
	}

	private renderItem(item: TodoItem, selected: boolean, width: number): string {
		const pointer = selected ? this.theme.fg("accent", "›") : " ";
		const marker = item.kind === "watch"
			? this.theme.fg(item.lastRun?.status === "failed" ? "error" : "accent", "◆")
			: item.done ? this.theme.fg("success", "✓") : this.theme.fg("dim", "○");
		const text = item.done ? this.theme.fg("dim", this.theme.strikethrough(item.text)) : this.theme.fg("text", item.text);
		const schedule = item.schedule?.enabled
			? this.theme.fg("dim", ` · ${item.schedule.action === "command" ? "run" : "remind"} ${item.schedule.every}`)
			: "";
		const current = item.id === getCurrentTaskId(this.state) ? this.theme.fg("accent", " · CURRENT") : "";
		return truncateToWidth(`${pointer} ${marker} ${this.theme.fg("accent", item.id)}  ${text}${schedule}${current}`, width, "…");
	}

	private isUp(data: string): boolean {
		return data === "k" || this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up");
	}

	private isDown(data: string): boolean {
		return data === "j" || this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down");
	}

	private isConfirm(data: string): boolean {
		return this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "return");
	}

	private isCancel(data: string): boolean {
		return this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
	}

	private listPageSize(): number {
		return Math.max(4, Math.min(8, Math.floor((process.stdout.rows ?? 28) * 0.85) - 10));
	}

	private frame(text: string, width: number, padded = false): string {
		const content = padded ? truncateToWidth(text, width, "") : this.pad(text, width);
		return this.theme.fg("border", "│") + content + this.theme.fg("border", "│");
	}

	private pad(text: string, width: number): string {
		const fitted = truncateToWidth(text, width, "…");
		return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	}

	private separator(width: number): string {
		return this.theme.fg("border", `├${"─".repeat(Math.max(1, width - 2))}┤`);
	}

	private border(title: string, width: number, edge: "top" | "bottom"): string {
		if (edge === "bottom") return this.theme.fg("border", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
		const label = ` ${title} `;
		const rest = Math.max(0, width - 4 - visibleWidth(label));
		return truncateToWidth(this.theme.fg("border", "╭──") + this.theme.fg("accent", this.theme.bold(label)) + this.theme.fg("border", `${"─".repeat(rest)}╮`), width, "");
	}

	private close(action: DashboardAction): void {
		if (this.closed) return;
		this.closed = true;
		this.done(action);
	}
}
