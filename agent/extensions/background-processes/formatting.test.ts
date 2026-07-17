import { describe, expect, test } from "bun:test";
import { AUTO_BUDGET, formatAutomaticResults, formatProcess, formatStartResult, formatWaitResult, WAIT_TOTAL_BYTES } from "./formatting.ts";
import type { BackgroundProcessSnapshot } from "./manager.ts";

function snapshot(id: string, output: string): BackgroundProcessSnapshot {
	return {
		id,
		command: "node test.js",
		title: `Job ${id}`,
		cwd: "C:/work",
		createdAt: 0,
		settledAt: 1000,
		status: "done",
		exitCode: 0,
		killRequested: false,
		settled: true,
		automaticDelivery: "deferred",
		output: { text: output, totalBytes: Buffer.byteLength(output), retainedBytes: Buffer.byteLength(output), droppedBytes: 0, truncated: false, version: 1 },
	};
}

describe("bounded formatting", () => {
	test("start results include the command", () => {
		const text = formatStartResult(snapshot("bg-1", ""));
		expect(text).toContain("Started bg-1: Job bg-1");
		expect(text).toContain("Command: node test.js");
	});

	test("process output is terminal-sanitized", () => {
		const text = formatProcess(snapshot("bg-1", "safe\x1b]0;secret\x07end"));
		expect(text).toContain("safeend");
		expect(text).not.toContain("secret");
	});

	test("automatic batches honor their total byte budget", () => {
		const output = `${"x".repeat(400)}\n`.repeat(200);
		const text = formatAutomaticResults([snapshot("bg-1", output), snapshot("bg-2", output)]);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(AUTO_BUDGET.maxBytes);
		expect(text.split("\n").length).toBeLessThanOrEqual(AUTO_BUDGET.maxLines);
	});

	test("multi-entry wait output honors its total byte budget", () => {
		const output = `${"y".repeat(300)}\n`.repeat(300);
		const text = formatWaitResult({ timedOut: false, settled: [snapshot("bg-1", output), snapshot("bg-2", output), snapshot("bg-3", output)], runningIds: [] });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(WAIT_TOTAL_BYTES);
	});
});
