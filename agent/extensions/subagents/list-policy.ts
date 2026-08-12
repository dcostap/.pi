export const MAX_LISTED_SUBAGENTS = 50;

export type RecentItems<T> = {
	items: T[];
	omitted: number;
};

/** Keep the newest items from a list that is ordered from oldest to newest. */
export function takeRecent<T>(items: readonly T[], limit = MAX_LISTED_SUBAGENTS): RecentItems<T> {
	const start = Math.max(0, items.length - limit);
	return {
		items: items.slice(start),
		omitted: start,
	};
}
