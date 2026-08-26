export type IncrementalWaitRecord = {
	state: string;
	deliveryConsumed: boolean;
};

export type ImplicitAnyWaitRecord = IncrementalWaitRecord & {
	deliveryPending: boolean;
};

export function implicitAnyWaitCandidates<T extends ImplicitAnyWaitRecord>(records: T[]): T[] {
	return records.filter((record) => !record.deliveryConsumed && (record.state !== "cold" || record.deliveryPending));
}

export function incrementalWaitState<T extends IncrementalWaitRecord>(records: T[]): {
	settled: T[];
	pending: T[];
} {
	return {
		settled: records.filter((record) => record.state === "cold" && !record.deliveryConsumed),
		pending: records.filter((record) => record.state !== "cold"),
	};
}
