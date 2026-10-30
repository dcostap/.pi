import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { BackgroundProcessManager, WaitAbortedError } from "./manager.ts";
import { ResultDeliveryCoordinator, type DeliveryPort } from "./result-delivery.ts";

class FakeOperations implements BashOperations {
	readonly completions = new Map<string, (value: { exitCode: number | null }) => void>();
	exec(command: string, _cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }) {
		return new Promise<{ exitCode: number | null }>((resolve, reject) => {
			this.completions.set(command, resolve);
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	}
	complete(command: string, exitCode = 0) {
		this.completions.get(command)!({ exitCode });
	}
}

class FakePort implements DeliveryPort {
	fail = false;
	messages: Array<Parameters<DeliveryPort["sendMessage"]>[0]> = [];
	options: Array<Parameters<DeliveryPort["sendMessage"]>[1]> = [];
	sendMessage(...[message, options]: Parameters<DeliveryPort["sendMessage"]>) {
		if (this.fail) throw new Error("send failed");
		this.messages.push(message);
		this.options.push(options);
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResultDeliveryCoordinator", () => {
	test("sends completion once with steering delivery and idle wake-up", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(1);
		expect(port.messages[0]!.content).toContain("bg-1");
		expect(port.messages[0]!.details).toMatchObject({
			processes: [{ id: "bg-1", title: "A", command: "a" }],
		});
		expect(port.options).toEqual([{ deliverAs: "steer", triggerTurn: true }]);
		expect(manager.get("bg-1").automaticDelivery).toBe("injected");
		delivery.flush();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("batches ready completions without waiting for agent settlement", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		operations.complete("a");
		operations.complete("b", 1);
		await tick();
		expect(port.messages).toHaveLength(1);
		expect(port.messages[0]!.details).toMatchObject({
			processes: [{ id: "bg-1", status: "done" }, { id: "bg-2", status: "failed" }],
		});
		delivery.flush();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("explicit status consumption suppresses deferred delivery", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		// A detailed status read can consume the result before the scheduled send.
		manager.subscribe((event) => {
			if (event.kind === "delivery") manager.get(event.id, true);
		});
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		delivery.flush();
		expect(port.messages).toHaveLength(0);
		delivery.dispose();
	});

	test("quick starts, waits, and completed kills do not send a second result", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		const quick = manager.startWithGracePeriod("quick", "Quick", ".", 100);
		operations.complete("quick");
		expect((await quick).settled).toBe(true);
		const started = manager.start("waited", "Waited", ".");
		const waiting = manager.wait([started.id]);
		operations.complete("waited");
		expect((await waiting).settled).toHaveLength(1);
		const stopped = manager.start("stopped", "Stopped", ".");
		expect((await manager.kill([stopped.id]))[0]!.outcome).toBe("killed");
		await tick();
		expect(port.messages).toHaveLength(0);
		delivery.dispose();
	});

	test("an unrelated completion leaves an active wait and its process running", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		let waitFinished = false;
		const waiting = manager.wait(["bg-1"]).then((result) => {
			waitFinished = true;
			return result;
		});
		operations.complete("b");
		await tick();
		expect(port.messages).toHaveLength(1);
		expect(waitFinished).toBe(false);
		expect(manager.get("bg-1")).toMatchObject({ status: "running", killRequested: false });
		operations.complete("a");
		expect((await waiting).settled).toHaveLength(1);
		await tick();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("an interrupted wait releases unseen completions for steering delivery", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		manager.start("b", "B", ".");
		const controller = new AbortController();
		const waiting = manager.wait(["bg-1", "bg-2"], { signal: controller.signal });
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(0);
		controller.abort();
		await expect(waiting).rejects.toBeInstanceOf(WaitAbortedError);
		await tick();
		expect(port.messages).toHaveLength(1);
		expect(port.messages[0]!.details).toMatchObject({ processes: [{ id: "bg-1" }] });
		expect(manager.get("bg-2").status).toBe("running");
		operations.complete("b");
		await tick();
		expect(port.messages).toHaveLength(2);
		delivery.dispose();
	});

	test("a failed injection stays deferred and can be retried", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		port.fail = true;
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(0);
		expect(manager.getDeferred()).toHaveLength(1);
		port.fail = false;
		delivery.flush();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("dispose suppresses a send that is already scheduled", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.subscribe((event) => {
			if (event.kind === "delivery") delivery.dispose();
		});
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		delivery.flush();
		expect(port.messages).toHaveLength(0);
	});

	test("dispose suppresses future injection", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		delivery.dispose();
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(0);
	});
});
