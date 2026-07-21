import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { CommandOutputCapture, formatCapturedOutput } from "./output-capture.ts";

const cleanupFiles = new Set<string>();
afterEach(() => {
	for (const path of cleanupFiles) rmSync(path, { force: true });
	cleanupFiles.clear();
});

describe("SSH command output capture", () => {
	test("keeps small output inline and removes its temporary file", () => {
		const capture = new CommandOutputCapture("small");
		capture.append(Buffer.from("hello\nworld\n"));
		const output = capture.finish();

		expect(output.truncated).toBe(false);
		expect(output.fullOutputPath).toBeUndefined();
		expect(output.text).toBe("hello\nworld\n");
	});

	test("retains a bounded tail and saves complete large output", () => {
		const full = Array.from({ length: 5000 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
		const capture = new CommandOutputCapture("large");
		capture.append(Buffer.from(full));
		expect(capture.dumpPathIfLarge).toBeTruthy();
		const output = capture.finish();

		expect(output.truncated).toBe(true);
		expect(output.outputLines).toBeLessThanOrEqual(2000);
		expect(output.fullOutputPath).toBeTruthy();
		cleanupFiles.add(output.fullOutputPath!);
		expect(existsSync(output.fullOutputPath!)).toBe(true);
		expect(readFileSync(output.fullOutputPath!, "utf8")).toBe(full);
		expect(formatCapturedOutput(output)).toContain(`Full output saved to: ${output.fullOutputPath}`);
	});
});
