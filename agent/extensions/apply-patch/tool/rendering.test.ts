import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearApplyPatchRenderState, renderApplyPatchCallFromState, setApplyPatchRenderState } from "./render-state.ts";
import { formatApplyPatchCollapsedDiff, formatApplyPatchSummary } from "./rendering.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	clearApplyPatchRenderState();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture(lineEnding = "\n") {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-render-"));
	temporaryDirectories.push(cwd);
	writeFileSync(join(cwd, "index.ts"), [
		'export const APP_NAME = "CastrosuaIa";',
		'export const APP_ID = "CastrosuaIA";',
		'export const LABEL = "Codex Sub";',
		'export const LEGACY_IDS = ["corp"] as const;',
		"",
	].join(lineEnding));

	const patchText = [
		"*** Begin Patch",
		"*** Update File: index.ts",
		"@@",
		'-export const APP_NAME = "CastrosuaIa";',
		'+export const APP_NAME = "Castrosua IA";',
		"*** End Patch",
	].join("\n");
	return { cwd, patchText };
}

function numberedFixture(firstChangedLine: number, secondChangedLine: number) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-render-overlap-"));
	temporaryDirectories.push(cwd);
	writeFileSync(join(cwd, "lines.txt"), Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
	const patchText = [
		"*** Begin Patch",
		"*** Update File: lines.txt",
		"@@",
		`-line ${firstChangedLine}`,
		`+line ${firstChangedLine} changed`,
		"@@",
		`-line ${secondChangedLine}`,
		`+line ${secondChangedLine} changed`,
		"*** End Patch",
	].join("\n");
	return { cwd, patchText };
}

const taggedTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

describe("apply_patch terminal rendering", () => {
	test("renders Codex's headerless first update chunk", () => {
		const { cwd } = fixture();
		const patchText = [
			"*** Begin Patch",
			"*** Update File: index.ts",
			'-export const APP_NAME = "CastrosuaIa";',
			'+export const APP_NAME = "Castrosua IA";',
			"*** End Patch",
		].join("\n");

		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);
		expect(preview).toContain('-1 export const APP_NAME = "CastrosuaIa";');
		expect(preview).toContain('+1 export const APP_NAME = "Castrosua IA";');
	});

	test("labels repeated-path operations as changes rather than files", () => {
		const { cwd } = fixture();
		const patchText = [
			"*** Begin Patch",
			"*** Delete File: index.ts",
			"*** Add File: index.ts",
			"+replacement",
			"*** End Patch",
		].join("\n");

		expect(formatApplyPatchSummary(patchText, cwd)).toStartWith("• Edited 2 changes ");
	});

	test("marks only the failed repeated-path action", () => {
		const { cwd } = fixture();
		const patchText = [
			"*** Begin Patch",
			"*** Delete File: index.ts",
			"*** Add File: index.ts",
			"+replacement",
			"*** End Patch",
		].join("\n");
		setApplyPatchRenderState("repeated-partial", patchText, cwd, "partial_failure", ["index.ts"], [1]);

		const rendered = renderApplyPatchCallFromState({ input: patchText }, taggedTheme, {
			toolCallId: "repeated-partial",
			cwd,
			argsComplete: true,
			showCollapsedDiff: true,
			settledStatus: "partial_failure",
		});

		expect(rendered).toContain("<success>✓ </success><toolDiffRemoved>DELETED</toolDiffRemoved> <accent>index.ts</accent>");
		expect(rendered).toContain("<error>! </error><accent>index.ts</accent><muted> — not applied</muted>");
	});

	test("merges hunks whose surrounding context overlaps", () => {
		const { cwd, patchText } = numberedFixture(5, 10);
		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);

		expect(preview).not.toContain("...");
		expect(preview.split("\n").filter((line) => line.endsWith("line 7"))).toHaveLength(1);
		expect(preview).toContain("- 5 line 5");
		expect(preview).toContain("+ 5 line 5 changed");
		expect(preview).toContain("-10 line 10");
		expect(preview).toContain("+10 line 10 changed");
	});

	test("merges hunks whose surrounding context ranges touch", () => {
		const { cwd, patchText } = numberedFixture(3, 10);
		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);

		expect(preview).not.toContain("...");
		expect(preview.split("\n").filter((line) => line.endsWith("line 7"))).toHaveLength(1);
	});

	test("merges hunks separated by a small visual context gap", () => {
		const { cwd, patchText } = numberedFixture(3, 14);
		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);

		expect(preview).not.toContain("...");
		expect(preview.split("\n").filter((line) => line.endsWith("line 8"))).toHaveLength(1);
		// The wider range is only for grouping; outer context remains three lines.
		expect(preview.split("\n").some((line) => line.endsWith("line 18"))).toBe(false);
	});

	test("keeps a separator between hunks beyond the wider overlap check", () => {
		const { cwd, patchText } = numberedFixture(3, 15);
		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);

		expect(preview).toContain("...");
	});

	test("keeps cached previews ANSI-free and styles with the callback theme", () => {
		const { cwd, patchText } = fixture("\r\n");
		const preview = formatApplyPatchCollapsedDiff(patchText, cwd);
		expect(preview).not.toContain("\r");
		expect(preview).not.toContain("\u001b");

		setApplyPatchRenderState("call-1", patchText, cwd);
		const rendered = renderApplyPatchCallFromState({ input: patchText }, taggedTheme, {
			toolCallId: "call-1",
			cwd,
			argsComplete: true,
			showCollapsedDiff: true,
			settledStatus: "success",
		});

		expect(rendered).toContain("<toolDiffRemoved>");
		expect(rendered).toContain("<toolDiffAdded>");
		expect(rendered).toContain("<toolDiffContext>");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain("\u001b");
	});

	test("does not emit inverse video that can corrupt background padding", () => {
		const { cwd, patchText } = fixture();
		setApplyPatchRenderState("call-2", patchText, cwd);

		const ansiTheme = {
			fg: (_role: string, text: string) => `\u001b[38;2;120;180;120m${text}\u001b[39m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		};
		const rendered = renderApplyPatchCallFromState({ input: patchText }, ansiTheme, {
			toolCallId: "call-2",
			cwd,
			argsComplete: true,
			showCollapsedDiff: true,
			settledStatus: "success",
		});

		expect(rendered).not.toContain("\u001b[7m");
		expect(rendered).not.toContain("\u001b[27m");
	});
});
