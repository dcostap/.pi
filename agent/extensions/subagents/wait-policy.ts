export type IncrementalWaitRecord = {
	state: string;
	deliveryConsumed: boolean;
};

export function incrementalWaitState<T extends IncrementalWaitRecord>(records: T[]): {
	settled: T[];
	pending: T[];
} {
	return {
		settled: records.filter((record) => record.state === "cold" && !record.deliveryConsumed),
		pending: records.filter((record) => record.state !== "cold"),
	};
}
