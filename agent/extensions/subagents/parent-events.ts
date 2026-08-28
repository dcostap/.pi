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

function outcomeTitle(outcome: CompletionSnapshot["outcome"]): string {
	if (outcome === "completed") return "Completion";
	if (outcome === "failed") return "Failure";
	if (outcome === "stopped") return "Stopped";
	if (outcome === "interrupted") return "Interrupted";
	return "Update";
}

function answer(snapshot: CompletionSnapshot): string {
	if (snapshot.outcome === "completed") return snapshot.finalAnswer || "(No final answer.)";
	return snapshot.error || snapshot.finalAnswer || "(No final answer.)";
}

function completionSection(snapshot: CompletionSnapshot, headingLevel: number): string {
	const heading = `${"#".repeat(headingLevel)} ${outcomeTitle(snapshot.outcome)} — ${snapshot.title}`;
	const metadata = `> ${snapshot.id}${snapshot.runId ? ` · ${snapshot.runId}` : ""} · ${snapshot.outcome}`;
	return `${heading}\n\n${metadata}\n\n${answer(snapshot)}`;
}

export function formatParentUpdates(updates: ParentUpdate[]): string {
	const sections = updates.map((update) => {
		if (update.kind === "report") {
			return `## Report — ${update.title}\n\n> ${update.id}${update.runId ? ` · ${update.runId}` : ""}\n\n${update.message}`;
		}
		if (update.kind === "completion") return completionSection(update.completion, 2);
		const failures = update.completions.filter((item) => item.outcome !== "completed").length;
		const summary = `${update.completions.length} subagent${update.completions.length === 1 ? "" : "s"} finished${failures ? ` · ${failures} failed/stopped` : ""}`;
		const completions = update.completions.map((item) => completionSection(item, 3)).join("\n\n---\n\n");
		return `## All selected subagents finished — ${update.label}\n\n> ${summary}\n\n${completions}`;
	});
	return `# Subagent updates\n\n${sections.join("\n\n---\n\n")}`;
}
