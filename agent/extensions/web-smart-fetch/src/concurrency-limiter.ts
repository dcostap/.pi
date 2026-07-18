type Waiter = {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export class ConcurrencyLimiter {
	readonly maxConcurrency: number;
	private activeCount = 0;
	private queue: Waiter[] = [];

	constructor(maxConcurrency: number) {
		this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency || 1));
	}

	get active(): number {
		return this.activeCount;
	}

	get pending(): number {
		return this.queue.length;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("Fetch aborted while waiting for a concurrency slot");
		if (this.activeCount < this.maxConcurrency) {
			this.activeCount += 1;
			return () => this.release();
		}

		return await new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			const onAbort = () => {
				this.remove(waiter);
				reject(new Error("Fetch aborted while waiting for a concurrency slot"));
			};
			waiter.onAbort = onAbort;
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(waiter);
		});
	}

	private release(): void {
		this.activeCount = Math.max(0, this.activeCount - 1);
		this.drain();
	}

	private remove(waiter: Waiter): void {
		const index = this.queue.indexOf(waiter);
		if (index >= 0) this.queue.splice(index, 1);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	private drain(): void {
		while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
			const waiter = this.queue.shift();
			if (!waiter) return;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Fetch aborted while waiting for a concurrency slot"));
				continue;
			}
			this.activeCount += 1;
			waiter.resolve(() => this.release());
		}
	}
}
