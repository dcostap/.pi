import { describe, expect, test } from "bun:test";
import type { BackgroundProcessSnapshot } from "../manager.ts";
import { processWidgetComponent, processWidgetLines } from "./process-widget.ts";

function snapshot(id: string, overrides: Partial<BackgroundProcessSnapshot> = {}): BackgroundProcessSnapshot {
	return {
		id,
		command: "bun test --watch",
		title: "Tests",
		cwd: "C:/work",
		createdAt: 1_000,
		status: "running",
		killRequested: false,
		settled: false,
		automaticDelivery: "none",
		output: {
			text: "collecting\n42 tests passed",
			totalBytes: 26,
			totalLines: 2,
			retainedBytes: 26,
			droppedBytes: 0,
			truncated: false,
			version: 1,
		},
		...overrides,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("background process widget", () => {
	test("shows each running terminal with its command, live activity, and elapsed time", () => {
		const lines = processWidgetLines([
			snapshot("bg-1"),
			snapshot("bg-2", { title: "Dev server", killRequested: true, output: { ...snapshot("x").output, text: "listening on :3000" } }),
		], theme, 13_000, 120);
		const text = lines.join("\n");

		expect(text).toContain("Background terminals · 2 running · 1 stopping · /ps to inspect");
		expect(text).toContain("bg-1");
		expect(text).toContain("Tests");
		expect(text).toContain("12s");
		expect(text).toContain("$ bun test --watch · 42 tests passed");
		expect(text).toContain("42 tests passed");
		expect(text).toContain("· stopping");
		expect(text).toContain("listening on :3000");
	});

	test("omits settled processes and falls back to the command before output arrives", () => {
		const emptyOutput = { ...snapshot("x").output, text: "", totalBytes: 0, totalLines: 0, retainedBytes: 0 };
		const lines = processWidgetLines([
			snapshot("bg-1", { output: emptyOutput }),
			snapshot("bg-2", { settled: true, status: "done", settledAt: 2_000 }),
		], theme, 2_000, 100);
		const text = lines.join("\n");

		expect(text).toContain("$ bun test --watch");
		expect(text).not.toContain("bg-2");
	});

	test("keeps every rendered line within the terminal width", () => {
		const component = processWidgetComponent([
			snapshot("bg-1", {
				title: "A deliberately very long background process title",
				output: { ...snapshot("x").output, text: "A very long latest output line that should be safely truncated" },
			}),
		], theme);

		for (const line of component.render(42)) expect(line.length).toBeLessThanOrEqual(42);
	});
});
