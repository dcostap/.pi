export type CompletionUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

export type CompletionSnapshot = {
	id: string;
	title: string;
	parentAgentId?: string;
	profile?: string;
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

export function completionCost(value: number): string {
	return value === 0 ? "$0.000" : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

export function completionDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatCompletionBatch(snapshots: CompletionSnapshot[]): string {
	const failures = snapshots.filter((snapshot) => snapshot.outcome !== "completed").length;
	const totalCost = snapshots.reduce((sum, snapshot) => sum + snapshot.usage.cost, 0);
	const totalTokens = snapshots.reduce((sum, snapshot) => sum + completionTokens(snapshot.usage), 0);
	const header = `# Subagent Batch Results\n\nAgents: ${snapshots.length} · failures: ${failures}\nTokens: ${totalTokens.toLocaleString("en-US")} · total cost: ${completionCost(totalCost)}`;
	const answers = snapshots.map((snapshot, index) => {
		const duration = snapshot.durationMs === undefined ? "unknown" : completionDuration(snapshot.durationMs);
		const answer = snapshot.outcome === "completed"
			? snapshot.finalAnswer || "(No final answer.)"
			: snapshot.error || snapshot.finalAnswer || "(No final answer.)";
		return `---\n\n## Agent ${index + 1} — ${snapshot.title}\n\n> ${snapshot.id}${snapshot.runId ? ` · ${snapshot.runId}` : ""} · ${snapshot.model} [${snapshot.thinking}] · ${snapshot.outcome}${snapshot.profile ? ` · profile ${snapshot.profile}` : ""}\n\n- **Attempts / model turns / duration:** ${snapshot.attempts} · ${snapshot.usage.turns} · ${duration}\n- **Tokens:** ${completionTokens(snapshot.usage).toLocaleString("en-US")} total (input ${snapshot.usage.input.toLocaleString("en-US")} · output ${snapshot.usage.output.toLocaleString("en-US")} · cache read ${snapshot.usage.cacheRead.toLocaleString("en-US")} · cache write ${snapshot.usage.cacheWrite.toLocaleString("en-US")})\n- **Exact cost:** ${completionCost(snapshot.usage.cost)}\n- **Session:** ${snapshot.sessionFile}\n\n${answer}`;
	});
	return [header, ...answers].join("\n\n");
}
