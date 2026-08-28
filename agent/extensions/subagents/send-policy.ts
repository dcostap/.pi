export type SubagentSendSelector =
	| { kind: "id"; id: string }
	| { kind: "ids"; ids: string[] }
	| { kind: "batch"; batchId: string }
	| { kind: "all_active_and_parked" };

export function parseSubagentSendSelector(input: {
	id?: string;
	ids?: string[];
	batch_id?: string;
	all_active_and_parked?: boolean;
}): SubagentSendSelector {
	const selectors = [
		input.id !== undefined,
		input.ids !== undefined,
		input.batch_id !== undefined,
		input.all_active_and_parked !== undefined,
	].filter(Boolean).length;
	if (selectors !== 1) throw new Error("Supply exactly one of id, ids, batch_id, or all_active_and_parked");
	if (input.id !== undefined) return { kind: "id", id: input.id };
	if (input.ids !== undefined) return { kind: "ids", ids: [...new Set(input.ids)] };
	if (input.batch_id !== undefined) return { kind: "batch", batchId: input.batch_id };
	if (input.all_active_and_parked !== true) throw new Error("all_active_and_parked must be true when selected");
	return { kind: "all_active_and_parked" };
}

export function isLiveMessageTarget(state: string): boolean {
	return state === "starting" || state === "running" || state === "parked";
}
