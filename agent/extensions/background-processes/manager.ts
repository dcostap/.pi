import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { TailBuffer, type TailBufferSnapshot } from "./tail-buffer.ts";

export type BackgroundProcessStatus = "running" | "done" | "failed" | "killed";
export type AutomaticDeliveryState = "none" | "deferred" | "sending" | "injected" | "consumed";

export interface BackgroundProcessSnapshot {
	readonly id: string;
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly settledAt?: number;
	readonly status: BackgroundProcessStatus;
	readonly exitCode?: number | null;
	readonly errorText?: string;
	readonly killRequested: boolean;
	readonly settled: boolean;
	readonly automaticDelivery: AutomaticDeliveryState;
	readonly output: TailBufferSnapshot;
}

interface BackgroundProcessEntry {
	readonly id: string;
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly controller: AbortController;
	readonly output: TailBuffer;
	completion: Promise<void>;
	status: BackgroundProcessStatus;
	settledAt?: number;
	exitCode?: number | null;
	errorText?: string;
	killRequested: boolean;
	settled: boolean;
	waitTokens: Set<symbol>;
	automaticDelivery: AutomaticDeliveryState;
}

export type ManagerEvent =
	| { kind: "started" | "output" | "settled" | "delivery" | "pruned"; id: string }
	| { kind: "disposing" };

export interface BackgroundProcessManagerOptions {
	maxRunning?: number;
	maxEntries?: number;
	maxOutputBytes?: number;
	now?: () => number;
}

export interface WaitOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onUpdate?: (runningIds: string[]) => void;
	updateIntervalMs?: number;
}

export interface WaitResult {
	readonly timedOut: boolean;
	readonly settled: BackgroundProcessSnapshot[];
	readonly runningIds: string[];
}

export type KillOutcome = "killed" | "settled-after-request" | "already-settled" | "termination-pending";

export interface KillResultItem {
	readonly id: string;
	readonly outcome: KillOutcome;
	readonly snapshot: BackgroundProcessSnapshot;
}

export interface DisposeResult {
	readonly timedOut: boolean;
	readonly stillRunningIds: string[];
}

export class WaitAbortedError extends Error {
	constructor(message = "Background wait aborted") {
		super(message);
		this.name = "WaitAbortedError";
	}
}

export class BackgroundProcessManager {
	private readonly entries = new Map<string, BackgroundProcessEntry>();
	private readonly listeners = new Set<(event: ManagerEvent) => void>();
	private readonly maxRunning: number;
	private readonly maxEntries: number;
	private readonly maxOutputBytes: number;
	private readonly now: () => number;
	private nextId = 1;
	private disposed = false;

	constructor(
		private readonly operations: BashOperations,
		options: BackgroundProcessManagerOptions = {},
	) {
		this.maxRunning = options.maxRunning ?? 8;
		this.maxEntries = options.maxEntries ?? 32;
		this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
		this.now = options.now ?? Date.now;
	}

	start(command: string, title: string, cwd: string): BackgroundProcessSnapshot {
		this.assertActive();
		if (this.runningCount >= this.maxRunning) {
			throw new Error(`At most ${this.maxRunning} background processes may run at once`);
		}
		this.pruneForStart();
		if (this.entries.size >= this.maxEntries) {
			throw new Error(`The ${this.maxEntries}-entry background process registry is full with no safe entry to prune`);
		}

		const id = `bg-${this.nextId++}`;
		const controller = new AbortController();
		const entry: BackgroundProcessEntry = {
			id,
			command,
			title,
			cwd,
			createdAt: this.now(),
			controller,
			output: new TailBuffer(this.maxOutputBytes),
			completion: Promise.resolve(),
			status: "running",
			killRequested: false,
			settled: false,
			waitTokens: new Set(),
			automaticDelivery: "none",
		};
		this.entries.set(id, entry);
		this.emit({ kind: "started", id });

		let execution: Promise<{ exitCode: number | null }>;
		try {
			execution = this.operations.exec(command, cwd, {
				signal: controller.signal,
				onData: (chunk) => {
					if (this.disposed || entry.settled) return;
					entry.output.append(chunk);
					this.emit({ kind: "output", id });
				},
			});
		} catch (error) {
			this.settleFailure(entry, error);
			entry.completion = Promise.resolve();
			return this.snapshotEntry(entry);
		}

		entry.completion = execution
			.then(({ exitCode }) => {
				if (exitCode === 0) this.settle(entry, "done", exitCode);
				else this.settle(entry, "failed", exitCode);
			})
			.catch((error) => {
				if (entry.killRequested && error instanceof Error && error.message === "aborted") {
					this.settle(entry, "killed", null);
					return;
				}
				this.settleFailure(entry, error);
			});

		return this.snapshotEntry(entry);
	}

	get runningCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) if (!entry.settled) count++;
		return count;
	}

	get size(): number {
		return this.entries.size;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	list(): BackgroundProcessSnapshot[] {
		return [...this.entries.values()].map((entry) => this.snapshotEntry(entry));
	}

	get(id: string, consumeDeferred = false): BackgroundProcessSnapshot {
		const entry = this.requireEntry(id);
		const snapshot = this.snapshotEntry(entry);
		if (consumeDeferred) this.consumeEntries([entry]);
		return snapshot;
	}

	validateIds(ids: string[]): string[] {
		const unique = [...new Set(ids)];
		for (const id of unique) this.requireEntry(id);
		return unique;
	}

	async wait(ids: string[], options: WaitOptions = {}): Promise<WaitResult> {
		this.assertActive();
		const unique = this.validateIds(ids);
		const entries = unique.map((id) => this.requireEntry(id));
		const token = Symbol("background-wait");
		for (const entry of entries) entry.waitTokens.add(token);

		return new Promise<WaitResult>((resolve, reject) => {
			let finished = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let updateTimer: ReturnType<typeof setInterval> | undefined;

			const cleanup = () => {
				unsubscribe();
				if (timeout) clearTimeout(timeout);
				if (updateTimer) clearInterval(updateTimer);
				options.signal?.removeEventListener("abort", onAbort);
			};

			const release = () => {
				for (const entry of entries) this.releaseWaitToken(entry, token);
			};

			const finish = (reason: "complete" | "timeout" | "abort" | "disposed") => {
				if (finished) return;
				finished = true;
				cleanup();

				if (reason === "abort" || reason === "disposed") {
					release();
					reject(new WaitAbortedError(reason === "disposed" ? "Background manager disposed" : undefined));
					return;
				}

				const settledEntries = entries.filter((entry) => entry.settled);
				const settled = settledEntries.map((entry) => this.snapshotEntry(entry));
				this.consumeEntries(settledEntries);
				release();
				resolve({
					timedOut: reason === "timeout",
					settled,
					runningIds: entries.filter((entry) => !entry.settled).map((entry) => entry.id),
				});
			};

			const check = (event?: ManagerEvent) => {
				if (event?.kind === "disposing") {
					finish("disposed");
					return;
				}
				if (entries.every((entry) => entry.settled)) finish("complete");
			};

			const onAbort = () => finish("abort");
			const unsubscribe = this.subscribe(check);

			if (options.timeoutMs !== undefined) {
				timeout = setTimeout(() => finish("timeout"), Math.max(0, options.timeoutMs));
			}
			if (options.onUpdate) {
				const emitUpdate = () => options.onUpdate?.(entries.filter((entry) => !entry.settled).map((entry) => entry.id));
				emitUpdate();
				updateTimer = setInterval(emitUpdate, options.updateIntervalMs ?? 1000);
			}
			if (options.signal) {
				if (options.signal.aborted) {
					finish("abort");
					return;
				}
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			check();
		});
	}

	async kill(ids: string[], timeoutMs = 5000): Promise<KillResultItem[]> {
		this.assertActive();
		const unique = this.validateIds(ids);
		const entries = unique.map((id) => this.requireEntry(id));
		const token = Symbol("background-kill");
		const requested = new Set<string>();

		for (const entry of entries) {
			entry.waitTokens.add(token);
			if (!entry.settled) {
				requested.add(entry.id);
				entry.killRequested = true;
				entry.controller.abort();
			}
		}

		await waitWithDeadline(Promise.all(entries.filter((entry) => requested.has(entry.id)).map((entry) => entry.completion)), timeoutMs);

		const snapshots = entries.map((entry) => this.snapshotEntry(entry));
		this.consumeEntries(entries.filter((entry) => entry.settled));
		for (const entry of entries) this.releaseWaitToken(entry, token);

		return snapshots.map((snapshot) => ({
			id: snapshot.id,
			outcome: !requested.has(snapshot.id)
				? "already-settled"
				: !snapshot.settled
					? "termination-pending"
					: snapshot.status === "killed"
						? "killed"
						: "settled-after-request",
			snapshot,
		}));
	}

	getDeferred(): BackgroundProcessSnapshot[] {
		return [...this.entries.values()]
			.filter((entry) => entry.settled && entry.waitTokens.size === 0 && entry.automaticDelivery === "deferred")
			.map((entry) => this.snapshotEntry(entry));
	}

	claimDeferred(ids: string[]): BackgroundProcessSnapshot[] {
		const claimed: BackgroundProcessSnapshot[] = [];
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (!entry || entry.automaticDelivery !== "deferred" || entry.waitTokens.size > 0) continue;
			entry.automaticDelivery = "sending";
			claimed.push(this.snapshotEntry(entry));
		}
		return claimed;
	}

	finishDelivery(ids: string[], succeeded: boolean): void {
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (!entry || entry.automaticDelivery !== "sending") continue;
			entry.automaticDelivery = succeeded ? "injected" : "deferred";
		}
	}

	subscribe(listener: (event: ManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(timeoutMs = 5000): Promise<DisposeResult> {
		if (this.disposed) return { timedOut: false, stillRunningIds: [] };
		this.disposed = true;
		this.emit({ kind: "disposing" });

		const running = [...this.entries.values()].filter((entry) => !entry.settled);
		for (const entry of running) {
			entry.killRequested = true;
			entry.controller.abort();
		}
		const completed = await waitWithDeadline(Promise.all(running.map((entry) => entry.completion)), timeoutMs);
		const stillRunningIds = running.filter((entry) => !entry.settled).map((entry) => entry.id);
		this.listeners.clear();
		this.entries.clear();
		return { timedOut: !completed && stillRunningIds.length > 0, stillRunningIds };
	}

	private settleFailure(entry: BackgroundProcessEntry, error: unknown): void {
		const text = error instanceof Error ? error.message : String(error);
		this.settle(entry, "failed", undefined, text.slice(0, 4096));
	}

	private settle(
		entry: BackgroundProcessEntry,
		status: Exclude<BackgroundProcessStatus, "running">,
		exitCode?: number | null,
		errorText?: string,
	): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.status = status;
		entry.exitCode = exitCode;
		entry.errorText = errorText;
		entry.settledAt = this.now();
		if (!this.disposed && entry.waitTokens.size === 0 && entry.automaticDelivery === "none") {
			entry.automaticDelivery = "deferred";
		}
		if (!this.disposed) {
			this.emit({ kind: "settled", id: entry.id });
			if (entry.automaticDelivery === "deferred") this.emit({ kind: "delivery", id: entry.id });
		}
	}

	private consumeEntries(entries: BackgroundProcessEntry[]): void {
		for (const entry of entries) {
			if (!entry.settled) continue;
			if (entry.automaticDelivery === "none" || entry.automaticDelivery === "deferred") {
				entry.automaticDelivery = "consumed";
			}
		}
	}

	private releaseWaitToken(entry: BackgroundProcessEntry, token: symbol): void {
		entry.waitTokens.delete(token);
		if (
			!this.disposed &&
			entry.settled &&
			entry.waitTokens.size === 0 &&
			entry.automaticDelivery === "none"
		) {
			entry.automaticDelivery = "deferred";
			this.emit({ kind: "delivery", id: entry.id });
		}
	}

	private pruneForStart(): void {
		if (this.entries.size < this.maxEntries) return;
		const candidates = [...this.entries.values()]
			.filter(
				(entry) =>
					entry.settled &&
					entry.waitTokens.size === 0 &&
					(entry.automaticDelivery === "injected" || entry.automaticDelivery === "consumed"),
			)
			.sort((left, right) => (left.settledAt ?? left.createdAt) - (right.settledAt ?? right.createdAt));
		for (const entry of candidates) {
			if (this.entries.size < this.maxEntries) break;
			this.entries.delete(entry.id);
			this.emit({ kind: "pruned", id: entry.id });
		}
	}

	private snapshotEntry(entry: BackgroundProcessEntry): BackgroundProcessSnapshot {
		return {
			id: entry.id,
			command: entry.command,
			title: entry.title,
			cwd: entry.cwd,
			createdAt: entry.createdAt,
			settledAt: entry.settledAt,
			status: entry.status,
			exitCode: entry.exitCode,
			errorText: entry.errorText,
			killRequested: entry.killRequested,
			settled: entry.settled,
			automaticDelivery: entry.automaticDelivery,
			output: entry.output.snapshot(),
		};
	}

	private requireEntry(id: string): BackgroundProcessEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown background process ID: ${id}`);
		return entry;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Background process manager is shutting down");
	}

	private emit(event: ManagerEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// One UI or delivery subscriber must not break process bookkeeping.
			}
		}
	}
}

async function waitWithDeadline(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
