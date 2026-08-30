import type { TodoItem, TodoState } from "./types.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TodoSchedulerOptions {
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	onDue: (item: TodoItem) => Promise<void> | void;
}

type ScheduleRecord = {
	dueAt: number;
	signature: string;
};

export class TodoScheduler {
	private readonly records = new Map<string, ScheduleRecord>();
	private readonly running = new Set<string>();
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private timer: TimerHandle | undefined;
	private state: TodoState | undefined;
	private stopped = true;

	constructor(private readonly options: TodoSchedulerOptions) {
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	start(state: TodoState): void {
		this.stopped = false;
		this.records.clear();
		this.state = state;
		this.sync(state);
	}

	stop(): void {
		this.stopped = true;
		this.state = undefined;
		this.records.clear();
		this.running.clear();
		if (this.timer) this.clearTimer(this.timer);
		this.timer = undefined;
	}

	sync(state: TodoState): void {
		this.state = state;
		if (this.stopped) return;
		const eligible = new Set<string>();
		const now = this.now();
		for (const item of state.items) {
			if (!isScheduled(item, state.scriptsEnabled)) continue;
			eligible.add(item.id);
			const signature = scheduleSignature(item);
			const current = this.records.get(item.id);
			if (!current || current.signature !== signature) {
				this.records.set(item.id, { dueAt: now + item.schedule!.intervalMs, signature });
			}
		}
		for (const id of [...this.records.keys()]) if (!eligible.has(id)) this.records.delete(id);
		this.arm();
	}

	nextDue(id: string): number | undefined {
		return this.records.get(id)?.dueAt;
	}

	private arm(): void {
		if (this.timer) this.clearTimer(this.timer);
		this.timer = undefined;
		if (this.stopped || this.records.size === 0) return;
		let next = Number.POSITIVE_INFINITY;
		for (const record of this.records.values()) next = Math.min(next, record.dueAt);
		const delay = Math.max(0, Math.min(2_147_000_000, next - this.now()));
		this.timer = this.setTimer(() => {
			this.timer = undefined;
			void this.fireDue();
		}, delay);
	}

	private async fireDue(): Promise<void> {
		if (this.stopped || !this.state) return;
		const now = this.now();
		const dueIds = [...this.records.entries()]
			.filter(([, record]) => record.dueAt <= now)
			.map(([id]) => id);

		for (const id of dueIds) {
			const item = this.state.items.find((candidate) => candidate.id === id);
			const record = this.records.get(id);
			if (!item?.schedule || !record) continue;
			record.dueAt = now + item.schedule.intervalMs;
			if (this.running.has(id)) continue;
			this.running.add(id);
			void Promise.resolve(this.options.onDue(structuredClone(item))).finally(() => {
				this.running.delete(id);
				if (!this.stopped) this.arm();
			});
		}
		this.arm();
	}
}

function isScheduled(item: TodoItem, scriptsEnabled: boolean): boolean {
	if (!item.schedule?.enabled) return false;
	if (item.kind === "task" && item.done) return false;
	if (item.schedule.action === "command" && !scriptsEnabled) return false;
	return true;
}

function scheduleSignature(item: TodoItem): string {
	const schedule = item.schedule!;
	return [
		item.kind,
		item.done ? "done" : "open",
		schedule.enabled ? "on" : "off",
		schedule.action,
		schedule.intervalMs,
		schedule.command ?? "",
		schedule.cwd ?? "",
		schedule.timeoutSeconds ?? "",
	].join("\u0000");
}
