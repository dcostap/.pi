export const MAX_RECENT_COMPLETED_SUBAGENTS = 10;

export function partitionSubagentList<T extends { state: string; settledAt?: number; updatedAt: number }>(
	items: readonly T[],
	completedLimit = MAX_RECENT_COMPLETED_SUBAGENTS,
): { active: T[]; completed: T[]; omittedCompleted: number } {
	const active = items.filter((item) => item.state !== "cold");
	const allCompleted = items
		.filter((item) => item.state === "cold")
		.sort((left, right) => (right.settledAt ?? right.updatedAt) - (left.settledAt ?? left.updatedAt));
	const completed = allCompleted.slice(0, completedLimit);
	return { active, completed, omittedCompleted: allCompleted.length - completed.length };
}
