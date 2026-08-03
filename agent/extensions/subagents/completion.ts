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

export type CompletionBatch = {
	id: string;
	title: string;
	role?: string;
	memberIds: string[];
};

export function completionTokens(usage: CompletionUsage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function completionCost(value: number): string {
	return value === 0 ? "$0.000" : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

export function cacheHitRate(usage: Pick<CompletionUsage, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
}

export function formatCacheHitRate(value: number | undefined, hasCacheUsage = true): string {
	return hasCacheUsage && typeof value === "number" && Number.isFinite(value) ? `CH${value.toFixed(1)}%` : "";
}

export function completionDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatAgentCompletion(snapshot: CompletionSnapshot, index: number, headingLevel: 2 | 3): string {
	const duration = snapshot.durationMs === undefined ? "unknown" : completionDuration(snapshot.durationMs);
	const answer = snapshot.outcome === "completed"
		? snapshot.finalAnswer || "(No final answer.)"
		: snapshot.error || snapshot.finalAnswer || "(No final answer.)";
	const cache = formatCacheHitRate(snapshot.usage.latestCacheHitRate, snapshot.usage.cacheRead > 0 || snapshot.usage.cacheWrite > 0);
	return `${"#".repeat(headingLevel)} Agent ${index + 1} — ${snapshot.title}

> ${snapshot.id}${snapshot.runId ? ` · ${snapshot.runId}` : ""}${snapshot.batchId ? ` · batch ${snapshot.batchId}` : ""} · ${snapshot.model} [${snapshot.thinking}] · ${snapshot.outcome}${snapshot.role ? ` · role ${snapshot.role}` : ""}

- **Attempts / model turns / duration:** ${snapshot.attempts} · ${snapshot.usage.turns} · ${duration}${cache ? ` · ${cache}` : ""}
- **Tokens:** ${completionTokens(snapshot.usage).toLocaleString("en-US")} total (input ${snapshot.usage.input.toLocaleString("en-US")} · output ${snapshot.usage.output.toLocaleString("en-US")} · cache read ${snapshot.usage.cacheRead.toLocaleString("en-US")} · cache write ${snapshot.usage.cacheWrite.toLocaleString("en-US")})
- **Exact cost:** ${completionCost(snapshot.usage.cost)}
- **Session:** ${snapshot.sessionFile}

${answer}`;
}

export function formatCompletionBatch(snapshots: CompletionSnapshot[], heading = "# Subagent Batch Results", batches: CompletionBatch[] = []): string {
	const failures = snapshots.filter((snapshot) => snapshot.outcome !== "completed").length;
	const totalCost = snapshots.reduce((sum, snapshot) => sum + snapshot.usage.cost, 0);
	const totalTokens = snapshots.reduce((sum, snapshot) => sum + completionTokens(snapshot.usage), 0);
	const header = `${heading}\n\nAgents: ${snapshots.length} · failures: ${failures}\nTokens: ${totalTokens.toLocaleString("en-US")} · total cost: ${completionCost(totalCost)}`;
	const batchById = new Map(batches.map((batch) => [batch.id, batch]));
	const groupOrder: string[] = [];
	const groups = new Map<string, CompletionSnapshot[]>();
	for (const snapshot of snapshots) {
		const key = snapshot.batchId ? `batch:${snapshot.batchId}` : "unbatched";
		if (!groups.has(key)) {
			groups.set(key, []);
			groupOrder.push(key);
		}
		groups.get(key)!.push(snapshot);
	}
	let agentIndex = 0;
	const sections = groupOrder.map((key) => {
		const group = groups.get(key)!;
		if (key === "unbatched") {
			return group.map((snapshot) => formatAgentCompletion(snapshot, agentIndex++, 2)).join("\n\n---\n\n");
		}
		const id = key.slice("batch:".length);
		const batch = batchById.get(id);
		const batchHeader = `## Batch — ${batch?.title ?? id}\n\n> ${id} · ${group.length} result${group.length === 1 ? "" : "s"}${batch?.role ? ` · role ${batch.role}` : ""}`;
		const agents = group.map((snapshot) => formatAgentCompletion(snapshot, agentIndex++, 3)).join("\n\n---\n\n");
		return `${batchHeader}\n\n${agents}`;
	});
	return [header, ...sections.map((section) => `---\n\n${section}`)].join("\n\n");
}
