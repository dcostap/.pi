import { describe, expect, test } from "bun:test";
import { getOutputWindow } from "./output-view.ts";
import type { BackgroundProcessSnapshot } from "../manager.ts";

function snapshot(text: string): BackgroundProcessSnapshot {
	return {
		id: "bg-1",
		command: "test",
		title: "test",
		cwd: ".",
		createdAt: 0,
		status: "running",
		killRequested: false,
		settled: false,
		automaticDelivery: "none",
		output: { text, totalBytes: Buffer.byteLength(text), totalLines: text ? text.split("\n").length : 0, retainedBytes: Buffer.byteLength(text), droppedBytes: 0, truncated: false, version: 1 },
	};
}

describe("getOutputWindow", () => {
	test("shows newest lines by default and scrolls toward older lines", () => {
		const value = snapshot("one\ntwo\nthree\nfour");
		expect(getOutputWindow(value, 20, 2, 0).lines).toEqual(["three", "four"]);
		expect(getOutputWindow(value, 20, 2, 1).lines).toEqual(["two", "three"]);
	});

	test("strips controls and constrains line width", () => {
		const view = getOutputWindow(snapshot("safe\x1b]0;hidden\x07-very-long-line"), 10, 2, 0);
		expect(view.lines).toHaveLength(1);
		expect(view.lines[0]).not.toContain("hidden");
		expect(view.lines[0]!.length).toBeLessThanOrEqual(10);
	});
});
