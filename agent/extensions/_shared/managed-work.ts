export const MANAGED_WORK_STATE_EVENT = "managed-work:state";

export type ManagedWorkStateEvent = {
	source: string;
	pending: boolean;
};
