import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	EVENT_REFRESH_DELAY_MS,
	GitStatusWidgetRuntime,
	MAX_FALLBACK_DELAY_MS,
	MIN_FALLBACK_DELAY_MS,
	WIDGET_ID,
	fallbackDelayMs,
	formatSnapshot,
	type RuntimeDependencies,
} from "./runtime.ts";
import type { GitSnapshot } from "./git.ts";

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
	return {
		branch: "main",
		headOid: "0123456789abcdef",
		changeCount: 0,
		hasTrackedChanges: false,
		stagedCount: 0,
		unstagedCount: 0,
		untrackedCount: 0,
		conflictedCount: 0,
		added: 0,
		removed: 0,
		lineStatsComplete: true,
		durationMs: 100,
		...overrides,
	};
}

class FakeClock {
	now = 0;
	private nextId = 1;
	private tasks = new Map<number, { dueAt: number; callback: () => void }>();

	setTimer = (callback: () => void, delayMs: number) => {
		const id = this.nextId++;
		this.tasks.set(id, { dueAt: this.now + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (timer: ReturnType<typeof setTimeout>) => {
		this.tasks.delete(timer as unknown as number);
	};

	nextDelay() {
		const next = [...this.tasks.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
		return next ? next.dueAt - this.now : undefined;
	}

	async runNext() {
		const next = [...this.tasks.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
		if (!next) throw new Error("No timer is scheduled");
		this.tasks.delete(next[0]);
		this.now = next[1].dueAt;
		next[1].callback();
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function harness(results: GitSnapshot[] = [snapshot()]) {
	const clock = new FakeClock();
	const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
	let calls = 0;
	const dependencies: RuntimeDependencies = {
		collectSnapshot: async (_cwd, options) => {
			return results[Math.min(calls++, results.length - 1)]!;
		},
		now: () => clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	};
	const ctx = {
		cwd: "C:/repo",
		ui: {
			setWidget: (id: string, lines: string[] | undefined) => widgets.push({ id, lines }),
		},
	} as unknown as ExtensionContext;
	return {
		clock,
		widgets,
		get calls() {
			return calls;
		},
		runtime: new GitStatusWidgetRuntime(ctx, dependencies),
	};
}

describe("widget formatting", () => {
	test("shows staged changes and marks incomplete additions as approximate", () => {
		const text = formatSnapshot(
			snapshot({ stagedCount: 1, unstagedCount: 2, added: 4, removed: 3, lineStatsComplete: false }),
		);
		expect(text).toContain("1 staged");
		expect(text).toContain("2 unstaged files");
		expect(text).toContain("~+4");
		expect(text).toContain("-3");
	});

	test("renders conflicts separately without inventing a staged plural", () => {
		const text = formatSnapshot(snapshot({ stagedCount: 2, conflictedCount: 2 }));
		expect(text).toContain("2 staged");
		expect(text).not.toContain("stageds");
		expect(text).toContain("2 conflicts");
	});
});

describe("adaptive fallback", () => {
	test("backs off repeated clean snapshots within the configured bounds", () => {
		expect(fallbackDelayMs(snapshot(), 1)).toBe(MIN_FALLBACK_DELAY_MS);
		expect(fallbackDelayMs(snapshot(), 2)).toBe(45_000);
		expect(fallbackDelayMs(snapshot(), 3)).toBe(MAX_FALLBACK_DELAY_MS);
		expect(fallbackDelayMs(snapshot({ durationMs: 10_000 }), 1)).toBe(MAX_FALLBACK_DELAY_MS);
	});

	test("does not apply clean backoff while changes are present", () => {
		expect(fallbackDelayMs(snapshot({ changeCount: 1, durationMs: 4_000 }), 3)).toBe(40_000);
	});
});

describe("runtime scheduling", () => {
	test("refreshes at startup and schedules from completion rather than a fixed interval", async () => {
		const testRuntime = harness();
		testRuntime.runtime.start();
		expect(testRuntime.clock.nextDelay()).toBe(0);
		await testRuntime.clock.runNext();
		expect(testRuntime.calls).toBe(1);
		expect(testRuntime.widgets[0]?.id).toBe(WIDGET_ID);
		expect(testRuntime.clock.nextDelay()).toBe(MIN_FALLBACK_DELAY_MS);
	});

	test("defers fallback work during an agent run and refreshes once after settling", async () => {
		const testRuntime = harness([snapshot(), snapshot({ changeCount: 1 })]);
		testRuntime.runtime.start();
		await testRuntime.clock.runNext();
		testRuntime.runtime.onAgentStart();
		await testRuntime.clock.runNext();
		expect(testRuntime.calls).toBe(1);
		testRuntime.runtime.onWorkingTreeMutation();
		testRuntime.runtime.onWorkingTreeMutation();
		testRuntime.runtime.onAgentSettled();
		expect(testRuntime.clock.nextDelay()).toBe(EVENT_REFRESH_DELAY_MS);
		await testRuntime.clock.runNext();
		expect(testRuntime.calls).toBe(2);
	});

	test("retains tool activity across multiple low-level agent starts", async () => {
		const testRuntime = harness();
		testRuntime.runtime.start();
		await testRuntime.clock.runNext();
		testRuntime.runtime.onAgentStart();
		testRuntime.runtime.onWorkingTreeMutation();
		testRuntime.runtime.onAgentStart();
		testRuntime.runtime.onAgentSettled();
		expect(testRuntime.clock.nextDelay()).toBe(EVENT_REFRESH_DELAY_MS);
	});

	test("refreshes after a no-tool prompt so external edits become visible", async () => {
		const testRuntime = harness();
		testRuntime.runtime.start();
		await testRuntime.clock.runNext();
		testRuntime.runtime.onUserInput();
		testRuntime.runtime.onAgentStart();
		testRuntime.runtime.onAgentSettled();
		expect(testRuntime.clock.nextDelay()).toBe(EVENT_REFRESH_DELAY_MS);
	});

	test("reports that manual refresh is unavailable while disabled", () => {
		const testRuntime = harness();
		testRuntime.runtime.setEnabled(false);
		expect(testRuntime.runtime.refreshNow()).toBe(false);
	});

	test("aborts an active collection when disabled", async () => {
		let release: (() => void) | undefined;
		const clock = new FakeClock();
		let observedSignal: AbortSignal | undefined;
		const ctx = { cwd: "C:/repo", ui: { setWidget() {} } } as unknown as ExtensionContext;
		const runtime = new GitStatusWidgetRuntime(ctx, {
			collectSnapshot: async (_cwd, options) => {
				observedSignal = options.signal;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			},
			now: () => clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		runtime.start();
		const running = clock.runNext();
		await Promise.resolve();
		runtime.setEnabled(false);
		expect(observedSignal?.aborted).toBe(true);
		release?.();
		await running;
	});
});
