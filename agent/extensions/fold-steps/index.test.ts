import { expect, test } from "bun:test";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, initTheme,
} from "@earendil-works/pi-coding-agent";
import install from "./index.ts";

initTheme("dark");

function setup(mode = "fullscreen") {
	const chat = new Container();
	const document = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	const tui = { children: [document], mode, renders: 0, requestRender() { this.renders++; } };
	const handlers: Record<string, Function> = {};
	const shortcuts: Record<string, Function> = {};
	const notes: string[] = [];
	install({
		on: (name: string, fn: Function) => { handlers[name] = fn; },
		registerShortcut: (key: string, opts: { handler: Function }) => { shortcuts[key] = opts.handler; },
	} as never);
	handlers.session_start!({}, {
		mode: "tui",
		ui: {
			setWidget: (_key: string, factory?: Function) => factory?.(tui, { fg: (_c: string, t: string) => t }),
			notify: (text: string) => notes.push(text),
		},
	});
	return { chat, tui, shortcuts, notes, handlers };
}

function user(chat: Container, text: string) {
	chat.addChild(new UserMessageComponent(text, getMarkdownTheme()));
}
function assistant(chat: Container, content: unknown[], stopReason: string, streaming = false) {
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
	component.updateContent({ role: "assistant", content, stopReason } as never, streaming);
	chat.addChild(component);
}
function tool(chat: Container, tui: unknown, id: string, path: string) {
	const component = new ToolExecutionComponent("read", id, { path }, {}, undefined, tui as never, "C:/x");
	component.updateResult({ content: [{ type: "text", text: `contents of ${path}` }], isError: false } as never);
	chat.addChild(component);
}
const lines = (chat: Container) => chat.render(60).map((line) => stripTerminalSequences(line).trimEnd());
const click = (chat: Container, y: number) => chat.handleMouse({
	type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 60, height: 999,
	shift: false, alt: false, ctrl: false,
} as never);

function finishedTurn(chat: Container, tui: unknown) {
	user(chat, "fix the bug");
	assistant(chat, [
		{ type: "thinking", thinking: "I should look around" },
		{ type: "text", text: "Let me check the token code" },
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
		{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.ts" } },
	], "toolUse");
	tool(chat, tui, "t1", "a.ts");
	tool(chat, tui, "t2", "b.ts");
	assistant(chat, [
		{ type: "thinking", thinking: "Found it" },
		{ type: "text", text: "Fixed. The token expired early." },
	], "stop");
}

test("folds steps between texts of a finished turn and toggles on click", () => {
	const { chat, tui, notes } = setup();
	expect(notes).toEqual([]);
	finishedTurn(chat, tui);
	const folded = lines(chat);
	const text = folded.join("\n");
	expect(text).toContain("fix the bug");
	expect(text).toContain("Let me check the token code");
	expect(text).toContain("Fixed. The token expired early.");
	expect(text).not.toContain("contents of a.ts");
	expect(text).not.toContain("I should look around");
	expect(text).not.toContain("Found it");
	expect(folded.filter((line) => line.includes("▸ 1 step")).length).toBe(1);
	expect(folded.filter((line) => line.includes("▸ 3 steps")).length).toBe(1);

	const row = folded.findIndex((line) => line.includes("▸ 3 steps"));
	click(chat, row);
	const open = lines(chat);
	expect(open[row]).toContain("▾ 3 steps");
	expect(open.join("\n")).toContain("contents of a.ts");
	expect(open.join("\n")).toContain("Found it");
	expect(open.join("\n")).not.toContain("I should look around");

	click(chat, row);
	expect(lines(chat)).toEqual(folded);

	const thinkingRow = folded.findIndex((line) => line.includes("▸ 1 step"));
	click(chat, thinkingRow);
	expect(lines(chat).join("\n")).toContain("I should look around");
});

test("keeps cancelled, failed, and running turns open", () => {
	for (const [stopReason, streaming] of [["aborted", false], ["error", false], ["stop", true], ["toolUse", false]] as const) {
		const { chat, tui } = setup();
		user(chat, "do it");
		assistant(chat, [
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "Working" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
		], "toolUse");
		tool(chat, tui, "t1", "a.ts");
		assistant(chat, [{ type: "text", text: "partial" }], stopReason, streaming);
		const text = lines(chat).join("\n");
		expect(text).toContain("contents of a.ts");
		expect(text).toContain("plan");
		expect(text).not.toContain("step");
	}
});

test("a finished answer without text stays open", () => {
	const { chat, tui } = setup();
	user(chat, "do it");
	assistant(chat, [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }], "toolUse");
	tool(chat, tui, "t1", "a.ts");
	assistant(chat, [{ type: "thinking", thinking: "done" }], "stop");
	expect(lines(chat).join("\n")).toContain("contents of a.ts");
});

test("older finished turns fold while the newest turn runs", () => {
	const { chat, tui } = setup();
	finishedTurn(chat, tui);
	user(chat, "next");
	assistant(chat, [{ type: "toolCall", id: "t9", name: "read", arguments: { path: "z.ts" } }], "toolUse");
	tool(chat, tui, "t9", "z.ts");
	const text = lines(chat).join("\n");
	expect(text).not.toContain("contents of a.ts");
	expect(text).toContain("contents of z.ts");
});

test("alt+o shows all steps, regular mode never folds, shutdown restores", () => {
	const { chat, tui, shortcuts, handlers } = setup();
	finishedTurn(chat, tui);
	shortcuts["alt+o"]!();
	expect(lines(chat).join("\n")).toContain("contents of a.ts");
	shortcuts["alt+o"]!();
	expect(lines(chat).join("\n")).not.toContain("contents of a.ts");
	tui.mode = "regular";
	expect(lines(chat).join("\n")).toContain("contents of a.ts");
	tui.mode = "fullscreen";
	handlers.session_shutdown!();
	expect(lines(chat).join("\n")).toContain("contents of a.ts");
});
