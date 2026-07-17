import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { BackgroundProcessManager } from "./manager.ts";
import { ResultDeliveryCoordinator, type DeliveryPort } from "./result-delivery.ts";

class FakeOperations implements BashOperations {
	readonly completions = new Map<string, (value: { exitCode: number | null }) => void>();
	exec(command: string, _cwd: string, _options: { onData: (data: Buffer) => void; signal?: AbortSignal }) {
		return new Promise<{ exitCode: number | null }>((resolve) => this.completions.set(command, resolve));
	}
	complete(command: string, exitCode = 0) {
		this.completions.get(command)!({ exitCode });
	}
}

class FakePort implements DeliveryPort {
	idle = true;
	fail = false;
	messages: Array<{ customType: string; content: string; display: boolean; details: unknown }> = [];
	isIdle() {
		return this.idle;
	}
	send(message: { customType: string; content: string; display: boolean; details: unknown }) {
		if (this.fail) throw new Error("send failed");
		this.messages.push(message);
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResultDeliveryCoordinator", () => {
	test("injects an idle settlement exactly once", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(1);
		expect(port.messages[0]!.content).toContain("bg-1");
		delivery.flushWhenIdle();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("defers while busy and flushes when agent settles", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		port.idle = false;
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		expect(port.messages).toHaveLength(0);
		port.idle = true;
		delivery.flushWhenIdle();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
	});

	test("explicit status consumption suppresses deferred delivery", async () => {
		const operations = new FakeOperations();
		const manager = new BackgroundProcessManager(operations);
		const port = new FakePort();
		port.idle = false;
		const delivery = new ResultDeliveryCoordinator(manager, port);
		manager.start("a", "A", ".");
		operations.complete("a");
		await tick();
		manager.get("bg-1", true);
		port.idle = true;
		delivery.flushWhenIdle();
		expect(port.messages).toHaveLength(0);
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
		delivery.flushWhenIdle();
		expect(port.messages).toHaveLength(1);
		delivery.dispose();
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
