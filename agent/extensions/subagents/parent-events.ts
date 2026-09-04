import type { CompletionSnapshot } from "./completion.ts";

export const MAX_REPORTS_PER_DELIVERY = 3;
export const MAX_COMPLETIONS_PER_DELIVERY = 3;

export type ParentReportUpdate = {
	kind: "report";
	id: string;
	title: string;
	runId?: string;
	createdAt: number;
	message: string;
};

export type ParentCompletionUpdate = {
	kind: "completion";
	createdAt: number;
	completion: CompletionSnapshot;
};

export type ParentCompletionGroupUpdate = {
	kind: "completion_group";
	notificationId?: string;
	createdAt: number;
	label: string;
	completions: CompletionSnapshot[];
};

export type ParentUpdate = ParentReportUpdate | ParentCompletionUpdate | ParentCompletionGroupUpdate;

export type ParentActivityAgent = {
	id: string;
	title: string;
	state: string;
};

export type ParentActivitySummary = {
	agents: ParentActivityAgent[];
};

const MAX_ACTIVITY_AGENTS = 6;

export function takeParentUpdateBatch(
	pending: ParentUpdate[],
	reportLimit = MAX_REPORTS_PER_DELIVERY,
	completionLimit = MAX_COMPLETIONS_PER_DELIVERY,
): ParentUpdate[] {
	if (reportLimit <= 0 && completionLimit <= 0) return [];
	const selected: ParentUpdate[] = [];
	let reports = 0;
	let completions = 0;
	for (let index = 0; index < pending.length;) {
		const update = pending[index]!;
		const isReport = update.kind === "report";
		if ((isReport && reports >= reportLimit) || (!isReport && completions >= completionLimit)) {
			index++;
			continue;
		}
		selected.push(update);
		pending.splice(index, 1);
		if (isReport) reports++;
		else completions++;
	}
	return selected.sort((left, right) => left.createdAt - right.createdAt);
}

export function consumeQueuedCompletion(pending: ParentUpdate[], id: string, runId: string): boolean {
	let consumed = false;
	for (let index = pending.length - 1; index >= 0; index--) {
		const update = pending[index]!;
		if (update.kind === "report") continue;
		if (update.kind === "completion") {
			if (update.completion.id !== id || update.completion.runId !== runId) continue;
			pending.splice(index, 1);
			consumed = true;
			continue;
		}
		const remaining = update.completions.filter((completion) => completion.id !== id || completion.runId !== runId);
		if (remaining.length === update.completions.length) continue;
		consumed = true;
		if (remaining.length === 0) pending.splice(index, 1);
		else update.completions = remaining;
	}
	return consumed;
}

export function consumeQueuedCompletion(pending: ParentUpdate[], id: string, runId: string): boolean {
	let consumed = false;
	for (let index = pending.length - 1; index >= 0; index--) {
		const update = pending[index]!;
		if (update.kind === "report") continue;
		if (update.kind === "completion") {
			if (update.completion.id !== id || update.completion.runId !== runId) continue;
			pending.splice(index, 1);
			consumed = true;
			continue;
		}
		const remaining = update.completions.filter((completion) => completion.id !== id || completion.runId !== runId);
		if (remaining.length === update.completions.length) continue;
		consumed = true;
		if (remaining.length === 0) pending.splice(index, 1);
		else update.completions = remaining;
	}
	return consumed;
}

function outcomeTitle(outcome: CompletionSnapshot["outcome"]): string {
	if (outcome === "completed") return "Managed subagent finished";
	if (outcome === "failed") return "Managed subagent failed and finished";
	if (outcome === "stopped") return "Managed subagent stopped";
	if (outcome === "interrupted") return "Managed subagent was interrupted";
	return "Managed subagent finished";
}

function answer(snapshot: CompletionSnapshot): string {
	if (snapshot.outcome === "completed") return snapshot.finalAnswer || "(No final answer.)";
	return snapshot.error || snapshot.finalAnswer || "(No final answer.)";
}

function completionSection(snapshot: CompletionSnapshot, headingLevel: number): string {
	const heading = `${"#".repeat(headingLevel)} ${outcomeTitle(snapshot.outcome)} — ${snapshot.title}`;
	const metadata = `> Final result · ${snapshot.id}${snapshot.runId ? ` · ${snapshot.runId}` : ""} · ${snapshot.outcome}`;
	return `${heading}\n\n${metadata}\n\n${answer(snapshot)}`;
}

function activityAddendum(summary: ParentActivitySummary): string {
	const agents = summary.agents;
	if (agents.length === 0) return "## Current managed activity\n\n> 0 direct subagents active";
	const stateCounts = new Map<string, number>();
	for (const agent of agents) stateCounts.set(agent.state, (stateCounts.get(agent.state) ?? 0) + 1);
	const counts = [...stateCounts.entries()].map(([state, count]) => `${count} ${state}`).join(" · ");
	const shown = agents.slice(0, MAX_ACTIVITY_AGENTS).map((agent) => `- ${agent.id} · ${agent.state} · ${agent.title}`);
	const omitted = agents.length - shown.length;
	const lines = [
		"## Current managed activity",
		"",
		`> ${agents.length} direct subagent${agents.length === 1 ? "" : "s"} active · ${counts}`,
		"",
		...shown,
	];
	if (omitted) lines.push(`- … ${omitted} more active`);
	return lines.join("\n");
}

export function formatParentUpdates(updates: ParentUpdate[], activity?: ParentActivitySummary): string {
	const terminalCount = updates.reduce((count, update) => count + (update.kind === "report" ? 0 : update.kind === "completion" ? 1 : update.completions.length), 0);
	const reportCount = updates.filter((update) => update.kind === "report").length;
	const sections = updates.map((update) => {
		if (update.kind === "report") {
			return `## Mid-task report — ${update.title}\n\n> ${update.id}${update.runId ? ` · ${update.runId}` : ""}\n\n${update.message}`;
		}
		if (update.kind === "completion") return completionSection(update.completion, 2);
		const failures = update.completions.filter((item) => item.outcome !== "completed").length;
		const summary = `${update.completions.length} subagent${update.completions.length === 1 ? "" : "s"} finished${failures ? ` · ${failures} failed/stopped` : ""}`;
		const completions = update.completions.map((item) => completionSection(item, 3)).join("\n\n---\n\n");
		return `## All selected managed subagents finished — ${update.label}\n\n> Final results · ${summary}\n\n${completions}`;
	});
	const title = terminalCount === 1 && reportCount === 0
		? "Managed subagent finished"
		: terminalCount > 0
			? "Managed subagent results"
			: "Managed subagent progress";
	const addendum = terminalCount > 0 && activity ? `\n\n---\n\n${activityAddendum(activity)}` : "";
	return `# ${title}\n\n${sections.join("\n\n---\n\n")}${addendum}`;
}
