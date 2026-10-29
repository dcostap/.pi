import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundProcessManager } from "./manager.ts";
import { formatAutomaticResults, processView } from "./formatting.ts";

export type DeliveryPort = Pick<ExtensionAPI, "sendMessage">;

export class ResultDeliveryCoordinator {
	private unsubscribe: (() => void) | undefined;
	private flushScheduled = false;
	private disposed = false;

	constructor(
		private readonly manager: BackgroundProcessManager,
		private readonly port: DeliveryPort,
	) {
		this.unsubscribe = manager.subscribe((event) => {
			if (event.kind === "delivery") this.scheduleFlush();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private scheduleFlush(): void {
		if (this.disposed || this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.flush();
		});
	}

	flush(): void {
		if (this.disposed) return;
		const deferred = this.manager.getDeferred();
		if (deferred.length === 0) return;
		const claimed = this.manager.claimDeferred(deferred.map((entry) => entry.id));
		if (claimed.length === 0) return;
		const ids = claimed.map((entry) => entry.id);
		try {
			this.port.sendMessage({
				customType: "background-process-result",
				content: formatAutomaticResults(claimed),
				display: true,
				details: { processes: claimed.map((entry) => processView(entry)) },
			}, { deliverAs: "steer", triggerTurn: true });
			this.manager.finishDelivery(ids, true);
		} catch {
			// Keep results deferred. A later agent_settled event or explicit flush retries them.
			this.manager.finishDelivery(ids, false);
		}
	}
}
