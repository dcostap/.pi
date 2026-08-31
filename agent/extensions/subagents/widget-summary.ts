export const SUBAGENT_HOUR_MS = 60 * 60_000;
export const SUBAGENT_DAY_MS = 24 * SUBAGENT_HOUR_MS;

type SummaryRecord = {
	active: boolean;
	createdAt: number;
	cost: number;
};

type WindowSummary = {
	count: number;
	cost: number;
};

export type SubagentWidgetSummary = {
	activeCount: number;
	totalCount: number;
	activeCost: number;
	totalCost: number;
	lastDay?: WindowSummary;
	lastHour?: WindowSummary;
};

function summarizeWindow(records: SummaryRecord[], since: number, now: number): WindowSummary {
	const recent = records.filter((record) => record.createdAt >= since && record.createdAt <= now);
	return {
		count: recent.length,
		cost: recent.reduce((sum, record) => sum + record.cost, 0),
	};
}

export function subagentWidgetSummary(
	records: SummaryRecord[],
	sessionStartedAt: number | undefined,
	now: number,
): SubagentWidgetSummary {
	const active = records.filter((record) => record.active);
	const historical = records.filter((record) => !record.active);
	const sessionAge = sessionStartedAt === undefined ? 0 : Math.max(0, now - sessionStartedAt);

	return {
		activeCount: active.length,
		// The active count is separate. "total" is the historical agent count.
		totalCount: historical.length,
		activeCost: active.reduce((sum, record) => sum + record.cost, 0),
		totalCost: records.reduce((sum, record) => sum + record.cost, 0),
		lastDay: sessionAge >= SUBAGENT_DAY_MS
			? summarizeWindow(historical, now - SUBAGENT_DAY_MS, now)
			: undefined,
		lastHour: sessionAge >= SUBAGENT_HOUR_MS
			? summarizeWindow(historical, now - SUBAGENT_HOUR_MS, now)
			: undefined,
	};
}
