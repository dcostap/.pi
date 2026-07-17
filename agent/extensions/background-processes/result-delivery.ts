import type { BackgroundProcessManager } from "./manager.ts";
import { formatAutomaticResults } from "./formatting.ts";

export interface DeliveryPort {
	isIdle(): boolean;
	send(message: {
		customType: string;
		content: string;
		display: boolean;
		details: unknown;
	}): void;
}

export class ResultDeliveryCoordinator {
	private unsubscribe: (() => void) | undefined;
	private flushScheduled = false;
	private disposed = false;

	constructor(
		private readonly manager: BackgroundProcessManager,
		private readonly port: DeliveryPort,
	) {
		this.unsubscribe = manager.subscribe((event) => {
			if (event.kind === "delivery") this.scheduleIfIdle();
		});
	}

	flushWhenIdle(): void {
		if (this.disposed || !this.port.isIdle()) return;
		this.flush();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private scheduleIfIdle(): void {
		if (this.disposed || this.flushScheduled || !this.port.isIdle()) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.flushWhenIdle();
		});
	}

	private flush(): void {
		const deferred = this.manager.getDeferred();
		if (deferred.length === 0) return;
		const claimed = this.manager.claimDeferred(deferred.map((entry) => entry.id));
		if (claimed.length === 0) return;
		const ids = claimed.map((entry) => entry.id);
		try {
			this.port.send({
				customType: "background-process-result",
				content: formatAutomaticResults(claimed),
				display: true,
				details: {
					processes: claimed.map((entry) => ({
						id: entry.id,
						title: entry.title,
						status: entry.status,
						exitCode: entry.exitCode,
						capturedBytes: entry.output.totalBytes,
					})),
				},
			});
			this.manager.finishDelivery(ids, true);
		} catch {
			// Keep results deferred. A later agent_settled event or explicit flush retries them.
			this.manager.finishDelivery(ids, false);
		}
	}
}
