import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { BackgroundProcessManager, WaitAbortedError } from "./manager.ts";

interface Execution {
	onData: (data: Buffer) => void;
	resolve: (value: { exitCode: number | null }) => void;
	reject: (error: Error) => void;
}

class FakeOperations implements BashOperations {
	readonly executions = new Map<string, Execution>();

	exec(command: string, _cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }) {
		return new Promise<{ exitCode: number | null }>((resolve, reject) => {
			const execution = { onData: options.onData, resolve, reject };
			this.executions.set(command, execution);
			const abort = () => reject(new Error("aborted"));
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
	}

	output(command: string, text: string) {
		this.executions.get(command)!.onData(Buffer.from(text));
	}

	complete(command: string, exitCode = 0) {
		this.executions.get(command)!.resolve({ exitCode });
	}

	fail(command: string, message: string) {
		this.executions.get(command)!.reject(new Error(message));
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BackgroundProcessManager", () => {
	test("starts immediately, captures output, and settles cleanly", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations, { maxOutputBytes: 5 });
		const started = manager.start("one", "First", "C:/work");
		expect(started).toMatchObject({ id: "bg-1", status: "running", settled: false });
		operations.output("one", "abcdefg");
		expect(manager.get("bg-1").output).toMatchObject({ text: "cdefg", droppedBytes: 2, retainedBytes: 5 });
		operations.complete("one", 0);
		await tick();
		expect(manager.get("bg-1")).toMatchObject({ status: "done", exitCode: 0, settled: true });
		expect(manager.getDeferred().map((entry) => entry.id)).toEqual(["bg-1"]);
	});

	test("classifies nonzero exits and backend failures", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("nonzero", "Nonzero", ".");
		manager.start("failure", "Failure", ".");
		operations.complete("nonzero", 7);
		operations.fail("failure", "spawn broke");
		await tick();
		expect(manager.get("bg-1")).toMatchObject({ status: "failed", exitCode: 7 });
		expect(manager.get("bg-2")).toMatchObject({ status: "failed", errorText: "spawn broke" });
	});

	test("kill uses the owned abort controller", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("server", "Server", ".");
		const result = await manager.kill(["bg-1"], 100);
		expect(result[0]).toMatchObject({ outcome: "killed", snapshot: { status: "killed", killRequested: true } });
		expect(manager.getDeferred()).toEqual([]);
	});

	test("wait returns all requested settlements and consumes delivery", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		const waiting = manager.wait(["bg-1", "bg-2", "bg-1"]);
		operations.complete("a");
		operations.complete("b", 2);
		const result = await waiting;
		expect(result.timedOut).toBe(false);
		expect(result.settled.map((entry) => entry.status)).toEqual(["done", "failed"]);
		expect(result.runningIds).toEqual([]);
		expect(manager.getDeferred()).toEqual([]);
	});

	test("wait timeout consumes only settled entries and leaves others running", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		const waiting = manager.wait(["bg-1", "bg-2"], { timeoutMs: 15 });
		operations.complete("a");
		const result = await waiting;
		expect(result).toMatchObject({ timedOut: true, runningIds: ["bg-2"] });
		expect(result.settled.map((entry) => entry.id)).toEqual(["bg-1"]);
		expect(manager.get("bg-2").status).toBe("running");
	});

	test("aborted wait consumes nothing and requeues a racing settlement", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("a", "A", ".");
		const controller = new AbortController();
		const waiting = manager.wait(["bg-1"], { signal: controller.signal });
		operations.complete("a");
		controller.abort();
		await expect(waiting).rejects.toBeInstanceOf(WaitAbortedError);
		await tick();
		expect(manager.getDeferred().map((entry) => entry.id)).toEqual(["bg-1"]);
	});

	test("overlapping waits do not cause automatic delivery", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("a", "A", ".");
		const first = manager.wait(["bg-1"]);
		const second = manager.wait(["bg-1"]);
		operations.complete("a");
		const [left, right] = await Promise.all([first, second]);
		expect(left.settled).toHaveLength(1);
		expect(right.settled).toHaveLength(1);
		expect(manager.getDeferred()).toEqual([]);
	});

	test("enforces running and total limits with safe pruning", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations, { maxRunning: 2, maxEntries: 3 });
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		expect(() => manager.start("c", "C", ".")).toThrow("At most 2");
		operations.complete("a");
		await tick();
		manager.start("c", "C", ".");
		operations.complete("b");
		await tick();
		expect(() => manager.start("d", "D", ".")).toThrow("registry is full");
		manager.get("bg-1", true);
		const started = manager.start("d", "D", ".");
		expect(started.id).toBe("bg-4");
		expect(() => manager.get("bg-1")).toThrow("Unknown");
	});

	test("dispose aborts every running execution and rejects active waits", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		const waiting = manager.wait(["bg-1"]);
		const disposed = manager.dispose(100);
		await expect(waiting).rejects.toBeInstanceOf(WaitAbortedError);
		expect(await disposed).toEqual({ timedOut: false, stillRunningIds: [] });
		expect(manager.size).toBe(0);
		expect(() => manager.start("c", "C", ".")).toThrow("shutting down");
	});
});
