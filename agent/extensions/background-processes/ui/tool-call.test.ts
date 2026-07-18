import { describe, expect, test } from "bun:test";
import { renderBackgroundStartCall, renderBackgroundToolCall, renderBackgroundToolResult } from "./tool-call.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("background start tool-call rendering", () => {
	test("shows the actual command and background title in chat history", () => {
		const component = renderBackgroundStartCall(
			{ command: "bun test ./src", title: "Unit tests" },
			theme,
		);

		expect(component.render(200).join("\n")).toBe("bash_bg_start $ bun test ./src (Unit tests)");
	});

	test("updates the existing component and strips terminal control sequences", () => {
		const component = renderBackgroundStartCall({ command: "old", title: "Old" }, theme);
		const updated = renderBackgroundStartCall(
			{ command: "safe\x1b]0;hidden\x07 command", title: "New\x1b[31m title" },
			theme,
			component,
		);

		expect(updated).toBe(component);
		expect(updated.render(200).join("\n")).toBe("bash_bg_start $ safe command (New title)");
	});

	test("prefixes every background tool and summarizes its arguments", () => {
		expect(renderBackgroundToolCall("bash_bg_status", { id: "bg-2" }, theme).render(200).join("\n"))
			.toBe("bash_bg_status bg-2");
		expect(renderBackgroundToolCall("bash_bg_wait", { ids: ["bg-2", "bg-3"], timeout_seconds: 30 }, theme).render(200).join("\n"))
			.toBe("bash_bg_wait bg-2, bg-3 (timeout 30s)");
		expect(renderBackgroundToolCall("bash_bg_list", {}, theme).render(200).join("\n"))
			.toBe("bash_bg_list");
		expect(renderBackgroundToolCall("bash_bg_kill", { ids: ["bg-4"] }, theme).render(200).join("\n"))
			.toBe("bash_bg_kill bg-4");
	});
});

describe("background tool-result rendering", () => {
	test("separates and styles structured status from command output", () => {
		const styledTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<b>${text}</b>`,
		} as any;
		const component = renderBackgroundToolResult(
			"bash_bg_status",
			{ content: [{ type: "text", text: "bg-2 — Dev server\nState: running\nElapsed: 2s\n\nready" }] },
			{ expanded: false, isPartial: false },
			styledTheme,
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("<accent><b>bg-2</b></accent>");
		expect(rendered).toContain("<muted>State:</muted> <accent>running</accent>");
		expect(rendered).toContain("<toolOutput>ready</toolOutput>");
	});

	test("collapses long status output until expanded", () => {
		const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const result = { content: [{ type: "text", text: `bg-1 — Logs\nState: running\nElapsed: 1s\n\n${output}` }] };
		const collapsed = renderBackgroundToolResult("bash_bg_status", result, { expanded: false, isPartial: false }, theme);
		const expanded = renderBackgroundToolResult("bash_bg_status", result, { expanded: true, isPartial: false }, theme);

		expect(collapsed.render(200).join("\n")).toContain("hidden lines, ctrl+e to expand");
		expect(collapsed.render(200).join("\n")).not.toContain("line 10\n");
		expect(expanded.render(200).join("\n")).toContain("line 10\n");
	});

	test("highlights inventory and stop outcomes", () => {
		const styledTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<b>${text}</b>`,
		} as any;
		const list = renderBackgroundToolResult(
			"bash_bg_list",
			{ content: [{ type: "text", text: "bg-1 [done] Build • 3s • 1.0KB • C:/work\nbg-2 [running] Server • 1s • 20B • C:/work" }] },
			{ expanded: false, isPartial: false },
			styledTheme,
		).render(200).join("\n");
		const kill = renderBackgroundToolResult(
			"bash_bg_kill",
			{ content: [{ type: "text", text: "bg-2: termination observed (killed)" }] },
			{ expanded: false, isPartial: false },
			styledTheme,
		).render(200).join("\n");

		expect(list).toContain("<success>[done]</success>");
		expect(list).toContain("<accent>[running]</accent>");
		expect(kill).toContain("<success>termination observed (killed)</success>");
	});
});
