import { describe, expect, test } from "bun:test";
import { ProcessDashboard } from "./process-dashboard.ts";
import type { BackgroundProcessSnapshot, ManagerEvent } from "../manager.ts";

function makeSnapshot(): BackgroundProcessSnapshot {
	return {
		id: "bg-1",
		command: "node server.js",
		title: "Server",
		cwd: "C:/work",
		createdAt: Date.now() - 1000,
		status: "running",
		killRequested: false,
		settled: false,
		automaticDelivery: "none",
		output: { text: "ready\nlistening", totalBytes: 15, totalLines: 2, retainedBytes: 15, droppedBytes: 0, truncated: false, version: 1 },
	};
}

class FakeManager {
	snapshot = makeSnapshot();
	listener: ((event: ManagerEvent) => void) | undefined;
	killCalls: string[][] = [];
	list() { return [this.snapshot]; }
	get() { return this.snapshot; }
	subscribe(listener: (event: ManagerEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
	async kill(ids: string[]) { this.killCalls.push(ids); return []; }
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const keybindings = {
	matches: (data: string, binding: string) =>
		(binding === "tui.select.up" && data === "UP") ||
		(binding === "tui.select.down" && data === "DOWN") ||
		(binding === "tui.select.confirm" && data === "\r") ||
		(binding === "tui.select.cancel" && data === "\x1b"),
} as any;

describe("ProcessDashboard", () => {
	test("renders list/detail, invokes kill, and disposes on close", async () => {
		const manager = new FakeManager();
		let renders = 0;
		let closes = 0;
		const dashboard = new ProcessDashboard(manager as any, theme, keybindings, () => renders++, () => closes++);
		expect(dashboard.render(80).join("\n")).toContain("Background Processes");
		expect(dashboard.render(80).join("\n")).toContain("1 running");
		dashboard.handleInput("\r");
		expect(dashboard.render(80).join("\n")).toContain("Output");
		dashboard.handleInput("x");
		expect(dashboard.render(80).join("\n")).toContain("Press x again to confirm");
		expect(manager.killCalls).toEqual([]);
		dashboard.handleInput("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.killCalls).toEqual([["bg-1"]]);
		dashboard.handleInput("\x1b");
		dashboard.handleInput("\x1b");
		expect(closes).toBe(1);
		expect(manager.listener).toBeUndefined();
		expect(renders).toBeGreaterThan(0);
	});

	test("keeps every framed line within the available width", () => {
		const manager = new FakeManager();
		manager.snapshot = {
			...manager.snapshot,
			title: "A very long process title that should be truncated without breaking the frame",
			cwd: "C:/a/very/long/path/that/will/not/fit/in/a/narrow/dashboard",
			command: "node ./a/very/long/path/to/a/server-entrypoint.js --with many arguments",
		};
		const dashboard = new ProcessDashboard(manager as any, theme, keybindings, () => {}, () => {});
		for (const line of dashboard.render(52)) expect(line.length).toBeLessThanOrEqual(52);
		dashboard.dispose();
	});
});
