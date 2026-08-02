import { describe, expect, test } from "bun:test";
import { applyRuntimeStatusEvent, type RuntimeStatusTarget } from "./runtime-events.ts";

function assistant(stopReason: string, errorMessage?: string) {
	return {
		type: "message_end",
		message: { role: "assistant", stopReason, errorMessage },
	};
}

describe("managed subagent runtime events", () => {
	test("clears a context overflow after compaction and a successful retry", () => {
		const status: RuntimeStatusTarget = {};

		applyRuntimeStatusEvent(status, assistant("error", "Your input exceeds the context window of this model"));
		expect(status.error).toContain("exceeds the context window");
		expect(applyRuntimeStatusEvent(status, { type: "compaction_start", reason: "overflow" })).toBe("compacting context (overflow)");
		expect(applyRuntimeStatusEvent(status, {
			type: "compaction_end",
			reason: "overflow",
			result: { summary: "summary" },
			aborted: false,
			willRetry: true,
		})).toBe("compaction completed (overflow); retrying task");

		applyRuntimeStatusEvent(status, assistant("toolUse"));
		expect(status.error).toBeUndefined();
		applyRuntimeStatusEvent(status, assistant("stop"));
		expect(status.error).toBeUndefined();
	});

	test("reports the real compaction failure instead of the triggering overflow", () => {
		const status: RuntimeStatusTarget = {};
		applyRuntimeStatusEvent(status, assistant("error", "context_length_exceeded"));

		const activity = applyRuntimeStatusEvent(status, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Context overflow recovery failed: Summarization failed: quota exceeded",
		});

		expect(activity).toBe("compaction failed (overflow)");
		expect(status.error).toBe("Context overflow recovery failed: Summarization failed: quota exceeded");
	});

	test("does not turn a completed task into a failure when post-answer threshold compaction fails", () => {
		const status: RuntimeStatusTarget = {};
		applyRuntimeStatusEvent(status, assistant("stop"));

		const activity = applyRuntimeStatusEvent(status, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: quota exceeded",
		});

		expect(activity).toBe("compaction failed (threshold)");
		expect(status.error).toBeUndefined();
	});

	test("preserves aborted runs and token-limit failures as failures", () => {
		const status: RuntimeStatusTarget = { error: "earlier error" };
		applyRuntimeStatusEvent(status, assistant("aborted"));
		expect(status.error).toBe("earlier error");

		applyRuntimeStatusEvent(status, assistant("length"));
		expect(status.error).toBe("Assistant response stopped at the token limit");
	});

	test("records final provider retry errors and clears them after recovery", () => {
		const status: RuntimeStatusTarget = {};
		expect(applyRuntimeStatusEvent(status, {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 4,
		})).toBe("provider retry 2/4 scheduled");

		applyRuntimeStatusEvent(status, {
			type: "auto_retry_end",
			success: false,
			finalError: "provider unavailable",
		});
		expect(status.error).toBe("provider unavailable");

		applyRuntimeStatusEvent(status, assistant("stop"));
		expect(status.error).toBeUndefined();
	});
});
