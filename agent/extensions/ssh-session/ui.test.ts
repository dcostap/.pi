import { describe, expect, test } from "bun:test";
import { renderSshCall, renderSshResult } from "./ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("SSH tool chat rendering", () => {
	test("summarizes commands when collapsed and shows them when expanded", () => {
		const command = "echo one\necho two\necho three";
		const collapsed = renderSshCall({ action: "exec", command, cwd: "/tmp" }, theme, false);
		const expanded = renderSshCall({ action: "exec", command, cwd: "/tmp" }, theme, true);

		expect(collapsed.render(200).join("\n")).toContain("# … 2 more lines");
		expect(collapsed.render(200).join("\n")).not.toContain("echo three");
		expect(expanded.render(200).join("\n")).toContain("echo three");
	});

	test("uses Ctrl+O expansion for long tool results while preserving the dump path", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		lines.push("[Output truncated: showing the latest output. Full output saved to: C:/temp/full.log]");
		lines.push("Use read with offset/limit or grep on that file to inspect the complete output.");
		lines.push("Exit code: 0");
		const result = { content: [{ type: "text", text: lines.join("\n") }], details: {} };

		const collapsed = renderSshResult(result, { expanded: false, isPartial: false }, theme);
		const expanded = renderSshResult(result, { expanded: true, isPartial: false }, theme);
		const collapsedText = collapsed.render(200).join("\n");
		const expandedText = expanded.render(200).join("\n");

		expect(collapsedText).toContain("ctrl+o to expand");
		expect(collapsedText).toContain("C:/temp/full.log");
		expect(collapsedText).not.toContain("line 20");
		expect(expandedText).toContain("line 20");
	});
});
