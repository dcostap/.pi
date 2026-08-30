import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { WatchRunner } from "./runner.ts";
import type { TodoItem } from "./types.ts";

function commandWatch(): TodoItem {
	return {
		id: "w-1",
		kind: "watch",
		text: "Check tests",
		createdAt: 1,
		updatedAt: 1,
		schedule: {
			enabled: true,
			every: "10m",
			intervalMs: 600_000,
			action: "command",
			command: "npm test",
			timeoutSeconds: 60,
		},
	};
}

describe("todo watch runner", () => {
	test("captures a successful command", async () => {
		const operations = {
			async exec(_command: string, _cwd: string, options: { onData?: (chunk: Buffer) => void }) {
				options.onData?.(Buffer.from("all good\n"));
				return { exitCode: 0 };
			},
		} as BashOperations;
		const result = await new WatchRunner(operations).run(commandWatch(), "C:/project");
		expect(result.status).toBe("success");
		expect(result.output).toBe("all good");
	});

	test("treats a nonzero exit as a failure", async () => {
		const operations = {
			async exec() { return { exitCode: 2 }; },
		} as unknown as BashOperations;
		const result = await new WatchRunner(operations).run(commandWatch(), "C:/project");
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(2);
	});

	test("rejects overlapping runs", async () => {
		let finish!: () => void;
		const operations = {
			exec() {
				return new Promise<{ exitCode: number }>((resolve) => { finish = () => resolve({ exitCode: 0 }); });
			},
		} as unknown as BashOperations;
		const runner = new WatchRunner(operations);
		const first = runner.run(commandWatch(), "C:/project");
		await expect(runner.run(commandWatch(), "C:/project")).rejects.toThrow("already running");
		finish();
		await first;
	});

	test("marks an explicitly cancelled run as cancelled", async () => {
		const operations = {
			exec(_command: string, _cwd: string, options: { signal: AbortSignal }) {
				return new Promise<{ exitCode: number }>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			},
		} as unknown as BashOperations;
		const runner = new WatchRunner(operations);
		const pending = runner.run(commandWatch(), "C:/project");
		runner.cancelAll();
		expect((await pending).status).toBe("cancelled");
	});
});
