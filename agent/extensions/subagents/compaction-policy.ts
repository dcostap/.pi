export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export type ManagedSubagentCompactionPolicy = {
	enabled: boolean;
	reserveTokens: number;
};

type ContextUsage = {
	tokens?: unknown;
	contextWindow?: unknown;
};

/**
 * A threshold compaction happens after a successful answer and has no retry to
 * serve. Managed subagents are made cold immediately afterwards, so generating
 * that summary would be wasted unless the parent later continues the session.
 */
export function shouldCancelManagedSubagentCompaction(event: { reason?: unknown; willRetry?: unknown }): boolean {
	return event.reason === "threshold" && event.willRetry !== true;
}

/** Decide whether a cold subagent needs its deferred compaction before a continuation. */
export function shouldCompactBeforeContinuation(
	runNumber: number,
	usage: ContextUsage | undefined,
	policy: ManagedSubagentCompactionPolicy,
): boolean {
	if (runNumber <= 1 || !policy.enabled || !usage) return false;
	const tokens = Number(usage.tokens);
	const contextWindow = Number(usage.contextWindow);
	if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	return tokens > Math.max(0, contextWindow - policy.reserveTokens);
}
