export type CompletionUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cache-hit rate of the latest assistant prompt, matching Pi's CH footer metric. */
	latestCacheHitRate?: number;
	cost: number;
	turns: number;
};

export type CompletionSnapshot = {
	id: string;
	title: string;
	parentAgentId?: string;
	batchId?: string;
	role?: string;
	outcome: "none" | "completed" | "failed" | "stopped" | "interrupted";
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	runId?: string;
	task: string;
	activity: string;
	createdAt: number;
	startedAt?: number;
	settledAt: number;
	durationMs?: number;
	attempts: number;
	usage: CompletionUsage;
	contextWindow?: number;
	contextTokens?: number;
	finalAnswer: string;
	error?: string;
	sessionFile: string;
};

export function completionTokens(usage: CompletionUsage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function cacheHitRate(usage: Pick<CompletionUsage, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
}

export function formatCacheHitRate(value: number | undefined, hasCacheUsage = true): string {
	return hasCacheUsage && typeof value === "number" && Number.isFinite(value) ? `CH${value.toFixed(1)}%` : "";
}
