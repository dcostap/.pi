import { existsSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { BackgroundOutputCapture } from "./output-capture.ts";

describe("BackgroundOutputCapture", () => {
	test("keeps ordinary output inline without creating a dump", () => {
		const capture = new BackgroundOutputCapture();
		capture.append(Buffer.from("hello\nworld\n"));
		capture.finish();

		expect(capture.snapshot()).toMatchObject({
			text: "hello\nworld\n",
			totalLines: 2,
			fullOutputPath: undefined,
		});
	});

	test("streams byte-truncated output to a persistent full-output file", () => {
		const capture = new BackgroundOutputCapture();
		const output = "x".repeat(DEFAULT_MAX_BYTES + 1);
		capture.append(Buffer.from(output));
		const path = capture.snapshot().fullOutputPath;
		capture.finish();

		expect(path).toBeTruthy();
		expect(existsSync(path!)).toBe(true);
		expect(readFileSync(path!, "utf8")).toBe(output);
		rmSync(path!, { force: true });
	});

	test("spills output that crosses the standard line limit", () => {
		const capture = new BackgroundOutputCapture();
		capture.append(Buffer.from("line\n".repeat(DEFAULT_MAX_LINES + 1)));
		const snapshot = capture.snapshot();
		capture.finish();

		expect(snapshot.totalLines).toBe(DEFAULT_MAX_LINES + 1);
		expect(snapshot.fullOutputPath).toBeTruthy();
		rmSync(snapshot.fullOutputPath!, { force: true });
	});
});
