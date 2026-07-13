import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearApplyPatchRenderState, renderApplyPatchCallFromState, setApplyPatchRenderState } from "./render-state.ts";
import { formatApplyPatchCollapsedDiff } from "./rendering.ts";

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

const taggedTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

describe("apply_patch terminal rendering", () => {
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
