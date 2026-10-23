import { describe, expect, test } from "bun:test";
import { savedOutputPaths } from "./output-files.ts";

describe("Chrome output file paths", () => {
	test("finds automatic dumps and explicit saved outputs", () => {
		expect(savedOutputPaths("preview\n[Dumped 12.5KB / 40 lines to C:/temp/file #1.txt | action=eval]\nUse read", "eval")).toEqual(["C:/temp/file #1.txt"]);
		expect(savedOutputPaths("preview\n[Saved 1.2KB / 8 lines to C:/temp/saved.txt]", "raw", "C:/temp/saved.txt")).toEqual(["C:/temp/saved.txt"]);
	});
	test("finds full accessibility trees, screenshots, and downloads", () => {
		expect(savedOutputPaths("nodes\n[Full accessibility tree saved to /tmp/tree.json]", "snap")).toEqual(["/tmp/tree.json"]);
		expect(savedOutputPaths("/tmp/shot.png\nScreenshot saved (viewport, png). DPR: 1", "shot")).toEqual(["/tmp/shot.png"]);
		expect(savedOutputPaths("/tmp/file.zip\nDownloaded 100 B from https://example.com", "download")).toEqual(["/tmp/file.zip"]);
	});
	test("does not treat ordinary output as a file path", () => {
		expect(savedOutputPaths("not a path\nplain output", "eval")).toEqual([]);
		expect(savedOutputPaths("Navigated", "nav", "/tmp/not-written.txt")).toEqual([]);
	});
});
