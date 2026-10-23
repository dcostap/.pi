import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import extension from "./index.ts";

let tool: any;
extension({ on() {}, registerTool(value: any) { if (value.name === "chrome_cdp") tool = value; } } as any);
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const cwd = resolve("chrome-test");
const previous = process.env.PI_TEST_HYPERLINKS;
beforeEach(() => { process.env.PI_TEST_HYPERLINKS = "1"; });
afterEach(() => {
	if (previous === undefined) delete process.env.PI_TEST_HYPERLINKS;
	else process.env.PI_TEST_HYPERLINKS = previous;
});
const render = (component: any) => component.render(200).join("\n");

describe("Chrome file link rendering", () => {
	test("keeps full link targets for shortened call paths", () => {
		const path = "long-directory-name/long-script-file-name-for-the-renderer.js";
		const text = render(tool.renderCall({ action: "script", expressionPath: path, outputPath: path }, theme, { cwd }));
		expect(text).toContain(`\x1b]8;;${pathToFileURL(resolve(cwd, path)).href}\x1b\\`);
		expect(text).toContain("…");
	});
	test("shows the automatic dump path instead of only saying file", () => {
		const path = resolve(cwd, "dump #1.txt");
		const result = { content: [{ type: "text", text: `preview\n[Dumped 3.1KB / 20 lines to ${path} | action=eval]` }], details: { action: "eval", dumped: true } };
		const text = render(tool.renderResult(result, { expanded: false }, theme, { cwd, args: {} }));
		expect(text).toContain(`\x1b]8;;${pathToFileURL(path).href}\x1b\\${path}\x1b]8;;\x1b\\`);
	});
	test("keeps evaluation failures visible beside saved output links", () => {
		const result = { content: [{ type: "text", text: "Eval failed: ReferenceError\nexpression" }], details: { action: "eval", outputPath: "error.txt" } };
		const text = render(tool.renderResult(result, { expanded: false }, theme, { cwd, args: {} }));
		expect(text).toContain("✗ ReferenceError");
		expect(text).toContain(pathToFileURL(resolve(cwd, "error.txt")).href);
	});
	test("shows the full saved path without controls when links are disabled", () => {
		delete process.env.PI_TEST_HYPERLINKS;
		const path = resolve(cwd, "saved.txt");
		const text = render(tool.renderResult({ content: [], details: { action: "raw", outputPath: path } }, { expanded: false }, theme, { cwd, args: {} }));
		expect(text).toContain(path);
		expect(text).not.toContain("\x1b]8;");
	});
});
