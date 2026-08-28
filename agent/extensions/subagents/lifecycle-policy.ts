export function managedSettlementAction(stopRequested: boolean, childPendingWork: boolean): "park" | "complete" {
	return !stopRequested && childPendingWork ? "park" : "complete";
}
