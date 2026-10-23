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
		origin: "bash_bg_start",
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
	test("one running process takes one line with no header", () => {
		const lines = processWidgetLines([snapshot("bg-1")], theme, 13_000, 120);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("bg-1");
		expect(lines[0]).toContain("Tests");
		expect(lines[0]).toContain("12s");
		expect(lines[0]).toContain("42 tests passed");
		expect(lines[0]).not.toContain("bun test --watch");
	});

	test("several processes get a short header and show stopping processes", () => {
		const lines = processWidgetLines([
			snapshot("bg-1"),
			snapshot("bg-2", { title: "Dev server", killRequested: true }),
		], theme, 13_000, 120);

		expect(lines[0]).toBe("2 background processes · /ps to inspect");
		expect(lines.join("\n")).toContain("stopping…");
	});

	test("shows at most five rows", () => {
		const many = Array.from({ length: 7 }, (_, index) => snapshot(`bg-${index + 1}`));
		const lines = processWidgetLines(many, theme, 13_000, 120);

		expect(lines).toHaveLength(6);
		expect(lines[0]).toContain("7 background processes");
		expect(lines[0]).toContain("2 older not shown");
		expect(lines.join("\n")).toContain("bg-7");
		expect(lines.join("\n")).not.toContain("bg-1 ");
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
		expect(lines).toHaveLength(1);
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

	test("an expanded process shows its full command, cwd, and output tail", () => {
		const lines = processWidgetLines([
			snapshot("bg-1", { command: "bun test --watch\n  --coverage" }),
			snapshot("bg-2", { title: "Dev server" }),
		], theme, 13_000, 120, "bg-1");
		const text = lines.join("\n");

		expect(text).toContain("$ bun test --watch");
		expect(text).toContain("--coverage");
		expect(text).toContain("cwd C:/work");
		expect(text).toContain("│ collecting");
		expect(text).toContain("│ 42 tests passed");
		expect(lines.findIndex((line) => line.includes("bg-2"))).toBeGreaterThan(lines.findIndex((line) => line.includes("cwd")));
	});

	test("a left click on a row or its details toggles that process", () => {
		const toggled: string[] = [];
		const component = processWidgetComponent([snapshot("bg-1"), snapshot("bg-2")], theme, undefined, {
			expandedId: "bg-1",
			onToggle: (id) => toggled.push(id),
		});
		const lines = component.render(120);
		const detailRow = lines.findIndex((line) => line.includes("cwd"));
		const secondRow = lines.findIndex((line) => line.includes("bg-2"));

		expect(component.handleMouse({ type: "click", button: "left", y: 0 })).toBeUndefined();
		expect(component.handleMouse({ type: "click", button: "left", y: detailRow })).toEqual({ handled: true });
		expect(component.handleMouse({ type: "press", button: "left", y: secondRow })).toBeUndefined();
		expect(component.handleMouse({ type: "click", button: "right", y: secondRow })).toBeUndefined();
		component.handleMouse({ type: "click", button: "left", y: secondRow });

		expect(toggled).toEqual(["bg-1", "bg-2"]);
	});
});
