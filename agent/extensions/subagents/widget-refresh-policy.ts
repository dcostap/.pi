const REFRESH_STEPS = [
	{ maximumNodes: 5, delayMs: 120 },
	{ maximumNodes: 10, delayMs: 200 },
	{ maximumNodes: 20, delayMs: 350 },
	{ maximumNodes: 40, delayMs: 600 },
] as const;

/** Use smooth updates for small trees and reduce render work as the tree grows. */
export function widgetRefreshDelay(nodeCount: number): number {
	const count = Number.isFinite(nodeCount) ? Math.max(0, nodeCount) : 0;
	return REFRESH_STEPS.find((step) => count <= step.maximumNodes)?.delayMs ?? 1_000;
}
