export type RuntimeStatusTarget = {
	error?: string;
	/** The stop reason of the most recent assistant message in this run. */
	lastAssistantStopReason?: string;
};

function compactionReason(event: any): string {
	return event?.reason === "manual" || event?.reason === "threshold" || event?.reason === "overflow"
		? event.reason
		: "unknown";
}

function latestAssistantMessage(messages: unknown): any | undefined {
	if (!Array.isArray(messages)) return undefined;
	return [...messages].reverse().find((message) => message?.role === "assistant");
}

function applyAssistantStatus(target: RuntimeStatusTarget, message: any): void {
	if (message?.role !== "assistant") return;
	target.lastAssistantStopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	if (message.stopReason === "stop" || message.stopReason === "toolUse") {
		// Successful output after an automatic retry/compaction recovery makes
		// the previous provider error historical rather than terminal.
		target.error = undefined;
		return;
	}
	if (message.stopReason === "length") {
		target.error = "Assistant response was cut short (provider stop reason: length)";
		return;
	}
	if (message.stopReason === "aborted") {
		target.error = message.errorMessage || target.error || "Assistant run aborted";
		return;
	}
	if (message.stopReason === "error" || message.errorMessage) {
		target.error = message.errorMessage || "assistant error";
	}
}

/**
 * Apply RPC lifecycle events that affect the final status of a managed run.
 *
 * Pi can emit an errored assistant message, recover through retry or
 * compaction, and only then emit agent_settled. A later successful assistant
 * message therefore supersedes the earlier error. Keeping this transition in
 * one small reducer prevents the manager from reporting recovered runs as
 * failed merely because it observed the initial provider error.
 */
export function applyRuntimeStatusEvent(target: RuntimeStatusTarget, event: any): string | undefined {
	if (event?.type === "agent_start") {
		// A new low-level run (including an automatic retry) must not inherit
		// the previous run's successful stop reason when deciding whether a
		// later error is terminal.
		target.lastAssistantStopReason = undefined;
		return;
	}

	if (event?.type === "message_end" && event.message?.role === "assistant") {
		applyAssistantStatus(target, event.message);
		return;
	}

	if (event?.type === "agent_end") {
		// A recovered low-level run is not guaranteed to expose a normal
		// message_end event to the RPC client. agent_end contains the finalized
		// messages, so use its last assistant message as the authoritative
		// outcome for this low-level run. A later agent_end can therefore
		// supersede an earlier provider error before agent_settled.
		const message = latestAssistantMessage(event.messages);
		if (message) applyAssistantStatus(target, message);
		return;
	}

	if (event?.type === "compaction_start") {
		return `compacting context (${compactionReason(event)})`;
	}

	if (event?.type === "compaction_end") {
		if (typeof event.errorMessage === "string" && event.errorMessage.trim()) {
			// Overflow compaction is part of recovering the failed task, so its
			// failure is terminal. Threshold/manual compaction can run after an
			// otherwise successful answer; retain that successful task outcome and
			// expose those failures as activity rather than turning it into a false
			// failed run.
			if (event.reason === "overflow") target.error = event.errorMessage.trim();
			return `compaction failed (${compactionReason(event)})`;
		}
		if (event.aborted) return `compaction aborted (${compactionReason(event)})`;
		if (event.result) {
			return event.willRetry
				? `compaction completed (${compactionReason(event)}); retrying task`
				: `compaction completed (${compactionReason(event)})`;
		}
		return `compaction ended without a result (${compactionReason(event)})`;
	}

	if (event?.type === "auto_retry_start") {
		const attempt = Number(event.attempt);
		const maximum = Number(event.maxAttempts);
		return Number.isFinite(attempt) && Number.isFinite(maximum)
			? `provider retry ${attempt}/${maximum} scheduled`
			: "provider retry scheduled";
	}

	if (event?.type === "auto_retry_end") {
		if (event.success) return "provider retry recovered";
		if (typeof event.finalError === "string" && event.finalError.trim()) {
			target.error = event.finalError.trim();
		}
		return "provider retries exhausted";
	}

	return;
}
