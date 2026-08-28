export type ManagedProcessStopControl = {
	requestDescendantStop: () => Promise<void>;
	abort: () => Promise<void>;
	waitForCompletion: (timeoutMs: number) => Promise<boolean>;
	terminate: () => Promise<void>;
	terminateTree: () => Promise<void>;
};

export type ManagedProcessStopMethod = "recursive" | "forced-tree";

export async function stopManagedProcessTree(control: ManagedProcessStopControl): Promise<ManagedProcessStopMethod> {
	try {
		await control.requestDescendantStop();
	} catch {
		await control.terminateTree();
		return "forced-tree";
	}

	try {
		await control.abort();
	} catch {}
	if (!await control.waitForCompletion(3_000)) await control.terminate();
	return "recursive";
}
