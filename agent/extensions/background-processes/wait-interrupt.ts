export type WaitInterruptReason = "steer" | "abort";

export type InterruptibleWait = {
	signal: AbortSignal;
	reason: () => WaitInterruptReason | undefined;
	dispose: () => void;
};

type WaitEntry = {
	controller: AbortController;
	reason?: WaitInterruptReason;
	removeOuterAbort: () => void;
};

export class WaitInterruptRegistry {
	private readonly entries = new Set<WaitEntry>();

	begin(outerSignal?: AbortSignal): InterruptibleWait {
		const entry: WaitEntry = {
			controller: new AbortController(),
			removeOuterAbort: () => {},
		};
		const onAbort = () => {
			entry.reason = "abort";
			entry.controller.abort();
		};
		if (outerSignal) {
			if (outerSignal.aborted) onAbort();
			else {
				outerSignal.addEventListener("abort", onAbort, { once: true });
				entry.removeOuterAbort = () => outerSignal.removeEventListener("abort", onAbort);
			}
		}
		this.entries.add(entry);
		return {
			signal: entry.controller.signal,
			reason: () => entry.reason,
			dispose: () => {
				entry.removeOuterAbort();
				this.entries.delete(entry);
			},
		};
	}

	interruptForSteer(): void {
		for (const entry of this.entries) {
			entry.reason = "steer";
			entry.controller.abort();
		}
	}

	abortAll(): void {
		for (const entry of this.entries) {
			entry.reason = "abort";
			entry.controller.abort();
		}
		this.entries.clear();
	}
}
