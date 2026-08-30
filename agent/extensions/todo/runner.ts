import { resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { TodoOutputCapture } from "./output-capture.ts";
import type { TodoItem, TodoRunSummary } from "./types.ts";

export class WatchRunner {
	private readonly running = new Map<string, AbortController>();

	constructor(
		private readonly operations: BashOperations,
		private readonly now: () => number = Date.now,
	) {}

	isRunning(id: string): boolean {
		return this.running.has(id);
	}

	async run(item: TodoItem, sessionCwd: string, signal?: AbortSignal): Promise<TodoRunSummary> {
		const schedule = item.schedule;
		if (item.kind !== "watch" || schedule?.action !== "command" || !schedule.command) {
			throw new Error(`${item.id} is not a command watch`);
		}
		if (this.running.has(item.id)) throw new Error(`${item.id} is already running`);

		const controller = new AbortController();
		this.running.set(item.id, controller);
		const capture = new TodoOutputCapture();
		const startedAt = this.now();
		let timedOut = false;
		let externallyCancelled = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, (schedule.timeoutSeconds ?? 300) * 1000);
		const onAbort = () => {
			externallyCancelled = true;
			controller.abort();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		let exitCode: number | null | undefined;
		let error: string | undefined;
		try {
			const cwd = resolve(sessionCwd, schedule.cwd ?? sessionCwd);
			const result = await this.operations.exec(schedule.command, cwd, {
				signal: controller.signal,
				onData: (chunk) => capture.append(chunk),
			});
			exitCode = result.exitCode;
		} catch (value) {
			error = value instanceof Error ? value.message : String(value);
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			this.running.delete(item.id);
		}

		const output = capture.finish();
		const status = (externallyCancelled || controller.signal.aborted) && !timedOut
			? "cancelled"
			: timedOut || error || exitCode !== 0
				? "failed"
				: "success";
		return {
			startedAt,
			finishedAt: this.now(),
			status,
			exitCode,
			timedOut: timedOut || undefined,
			output: tailLines(output.text, 24, 12 * 1024),
			totalBytes: output.totalBytes,
			totalLines: output.totalLines,
			truncated: output.truncated,
			fullOutputPath: output.fullOutputPath,
			error,
		};
	}

	cancelAll(): void {
		for (const controller of this.running.values()) controller.abort();
	}
}

function tailLines(text: string, maxLines: number, maxBytes: number): string {
	let lines = text.replace(/\r\n/gu, "\n").split("\n").slice(-maxLines);
	let value = lines.join("\n").trimEnd();
	while (Buffer.byteLength(value, "utf8") > maxBytes && lines.length > 1) {
		lines = lines.slice(1);
		value = lines.join("\n").trimEnd();
	}
	if (Buffer.byteLength(value, "utf8") > maxBytes) {
		value = Buffer.from(value, "utf8").subarray(-maxBytes).toString("utf8");
	}
	return value;
}
