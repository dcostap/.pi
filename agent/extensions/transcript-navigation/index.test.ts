import { describe, expect, test } from "bun:test";
import {
	Container, CURSOR_MARKER, Markdown, ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack,
	type Component, type OverlayHandle, type Terminal, type TuiAltScreenOptions,
} from "@earendil-works/pi-tui";
import { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import install from "./index.ts";
import { TranscriptReader } from "./reader.ts";
import { readRenderedTranscript } from "./snapshot.ts";

class MemoryTerminal implements Terminal {
	columns = 60;
	rows = 8;
	kittyProtocolActive = false;
	input: (data: string) => void = () => {};
	writes: string[] = [];
	start(onInput: (data: string) => void) { this.input = onInput; }
	stop() {}
	async drainInput() {}
	write(data: string) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

function fixture(fullscreen = true, content?: Component, options: TuiAltScreenOptions = {}) {
	const terminal = new MemoryTerminal();
	const tui = fullscreen ? new TuiAltScreen(terminal, false, undefined, options) : new TuiMainScreen(terminal);
	const transcript = new Text(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), 0, 0);
	const scroll = new ScrollView(content ?? transcript, { primary: true, follow: "end", scrollbar: "hidden" });
	const draft = { text: "keep this prompt", cursor: 4, selection: [1, 4] };
	let promptInputs = 0;
	const prompt = {
		focused: true,
		render: () => [`prompt: ${draft.text.slice(0, draft.cursor)}${CURSOR_MARKER}${draft.text.slice(draft.cursor)}`],
		handleInput: () => { promptInputs++; },
		invalidate() {},
	};
	if (tui instanceof TuiAltScreen) {
		tui.setLayoutRoot(new VStack([
			{ component: scroll, basis: 0, grow: 1 },
			{ component: prompt, basis: 1 },
		]));
	} else {
		tui.addChild(transcript);
		tui.addChild(prompt);
	}
	tui.setFocus(prompt);
	tui.start();
	const render = () => (tui as any).doRender();
	render();

	let shortcut!: (ctx: any) => Promise<void>;
	let shutdown!: () => void;
	const notices: string[] = [];
	install({
		registerShortcut(key: string, options: any) {
			expect(key).toBe("f2");
			shortcut = options.handler;
		},
		on(event: string, handler: () => void) {
			expect(event).toBe("session_shutdown");
			shutdown = handler;
		},
	} as any);
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text: string) => notices.push(text),
			custom: (factory: any, options: any) => new Promise<void>((resolve) => {
				let handle: OverlayHandle | undefined;
				let closed = false;
				const done = () => {
					if (closed) return;
					closed = true;
					handle?.hide();
					resolve();
				};
				const component = factory(tui, { fg: (_color: string, text: string) => text }, {}, done);
				if (!closed) handle = tui.showOverlay(component, options.overlayOptions);
			}),
		},
	};
	return {
		tui, terminal, scroll, transcript, draft, prompt, notices, render, shutdown,
		open: () => shortcut(ctx), promptInputs: () => promptInputs,
	};
}

describe("Pi 1.0 fullscreen integration", () => {
	test("hides the terminal cursor in block mode and shows it in caret mode", async () => {
		const content = new Container();
		content.addChild(new UserMessageComponent("question", getMarkdownTheme(), 0));
		const f = fixture(true, content);
		try {
			f.tui.setShowHardwareCursor(true);
			const pending = f.open();
			f.render();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			expect(reader.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
			expect((f.tui as TuiAltScreen).getScreenLines().join("\n")).not.toContain("\x1b[7;4m");
			expect(f.terminal.writes.at(-1)).toContain("\x1b[?25l");
			f.terminal.input("\x1b[12~");
			f.render();
			expect(f.terminal.writes.at(-1)).toContain("\x1b[?25h");
			expect(reader.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
			expect((f.tui as TuiAltScreen).getScreenLines().join("\n")).not.toContain("\x1b[7;4m");
			f.shutdown();
			await pending;
			expect(f.tui.getShowHardwareCursor()).toBe(true);
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
		} finally { f.tui.stop(); }
	});

	test("wheel uses native speed and Alt multiplier, then keeps the position after exit and new output", async () => {
		const f = fixture(true, undefined, { wheelScrollLines: 3 });
		try {
			const nativeTop = f.scroll.scrollTop;
			const pending = f.open();
			f.render();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			f.terminal.input("\x1b[<64;2;2M"); // Wheel up.
			expect(reader.viewportTop).toBe(nativeTop - 3);
			f.render();
			f.terminal.input("\x1b[<72;2;2M"); // Alt+wheel up.
			expect(reader.viewportTop).toBe(0);
			f.terminal.input("\x1b[<65;2;2M"); // Wheel down.
			expect(reader.viewportTop).toBe(3);
			expect(f.scroll.scrollTop).toBe(nativeTop);
			f.terminal.input("\x1b");
			await pending;
			expect(f.scroll.scrollTop).toBe(3);
			expect(f.scroll.isFollowingEnd).toBe(false);
			f.transcript.setText(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
			f.render();
			expect(f.scroll.scrollTop).toBe(3);
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
		} finally { f.tui.stop(); }
	});

	test.each([false, true])("native drag selection and right-click use Pi's copy setting (%s)", async (autoCopy) => {
		const copies: string[] = [];
		const f = fixture(true, undefined, { copyOnSelect: autoCopy, copySelection: async (text) => {
			copies.push(text);
			return true;
		} });
		try {
			const pending = f.open();
			f.render();
			f.terminal.input("\x1b[<0;1;1M");
			f.terminal.input("\x1b[<32;4;1M");
			f.terminal.input("\x1b[<0;4;1m");
			expect((f.tui as TuiAltScreen).hasActiveSelection()).toBe(true);
			expect(copies).toEqual(autoCopy ? ["line"] : []);
			f.terminal.input("\x1b[<2;1;1M");
			f.terminal.input("\x1b[<2;1;1m");
			await Promise.resolve();
			expect(copies).toEqual(["line"]);
			expect(f.promptInputs()).toBe(0);
			expect(f.draft.text).toBe("keep this prompt");
			f.shutdown();
			await pending;
		} finally { f.tui.stop(); }
	});

	test("exit at the end does not resume following new output", async () => {
		const f = fixture();
		try {
			const top = f.scroll.scrollTop;
			expect(f.scroll.isFollowingEnd).toBe(true);
			const pending = f.open();
			f.render();
			f.terminal.input("\x1b[<65;2;2M");
			f.terminal.input("\x1b");
			await pending;
			expect(f.scroll.scrollTop).toBe(top);
			expect(f.scroll.isFollowingEnd).toBe(false);
			f.transcript.setText(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
			f.render();
			expect(f.scroll.scrollTop).toBe(top);
			f.scroll.scrollToEnd();
			expect(f.scroll.isFollowingEnd).toBe(true);
		} finally { f.tui.stop(); }
	});

	test("reads the native buffer, captures navigation, and restores prompt focus", async () => {
		const f = fixture();
		try {
			const before = { ...f.draft, selection: [...f.draft.selection] };
			const nativeTop = f.scroll.scrollTop;
			expect(readRenderedTranscript(f.tui)?.lines).toHaveLength(20);
			const pending = f.open();
			f.render();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			expect(reader).toBeInstanceOf(TranscriptReader);
			f.terminal.input("\x1b[12~"); // F2 enters caret navigation.
			f.terminal.input("\x1b[1;5H"); // Ctrl+Home
			f.terminal.input("\x1b[1;2C"); // Shift+Right
			expect(reader.getSelectedText()).toBe("l");
			f.terminal.input("\x1b[6~"); // PageDown must reach the reader, not the native viewport.
			expect(f.scroll.scrollTop).toBe(nativeTop);
			f.render();
			const readerTop = reader.viewportTop;
			f.terminal.input("x");
			f.terminal.input("\x1b[200~paste\x1b[201~");
			f.terminal.input("\r");
			expect(f.promptInputs()).toBe(0);
			f.terminal.input("\x1b"); // Return to blocks.
			f.terminal.input("\x1b"); // Return to the prompt.
			await pending;
			expect(f.tui.hasOverlay()).toBe(false);
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
			expect(f.scroll.scrollTop).toBe(readerTop);
			f.render();
			expect(readRenderedTranscript(f.tui)?.top).toBe(readerTop);
			expect(f.draft).toEqual(before);
			f.terminal.input("x");
			expect(f.promptInputs()).toBe(1);
		} finally { f.tui.stop(); }
	});

	test("keeps a fixed view while native output grows; reopening refreshes it", async () => {
		const f = fixture();
		try {
			let pending = f.open();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			f.terminal.input("\x1b[12~");
			f.terminal.input("\x01");
			const selected = reader.getSelectedText();
			f.transcript.setText("new output");
			f.render();
			expect(reader.getSelectedText()).toBe(selected);
			f.terminal.input("\x1b");
			f.terminal.input("\x1b");
			await pending;
			pending = f.open();
			f.terminal.input("\x1b[12~");
			f.terminal.input("\x01");
			expect((f.tui.getFocusedComponent() as TranscriptReader).getSelectedText()).toBe("new output");
			f.shutdown();
			await pending;
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
		} finally { f.tui.stop(); }
	});

	test("keeps native colors and formatting in the overlay while copying plain text", async () => {
		const f = fixture();
		try {
			f.transcript.setText("\x1b[32;1mheading\x1b[0m\n  \x1b[34mcode\x1b[0m");
			f.render();
			const pending = f.open();
			f.terminal.input("\x1b[12~");
			f.terminal.input("\x01");
			f.render();
			const screen = (f.tui as TuiAltScreen).getScreenLines();
			expect(screen[0]).toContain("\x1b[32;1m");
			expect(screen[1]).toContain("\x1b[34m");
			expect((f.tui.getFocusedComponent() as TranscriptReader).getSelectedText()).toBe("heading\n  code");
			f.terminal.input("\x1b");
			f.terminal.input("\x1b");
			await pending;
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
		} finally { f.tui.stop(); }
	});

	test("does not add a second reader or replace an existing overlay", async () => {
		const f = fixture();
		try {
			const pending = f.open();
			const reader = f.tui.getFocusedComponent();
			await f.open();
			expect(f.tui.getFocusedComponent()).toBe(reader);
			f.shutdown();
			await pending;
			const dialog = new Text("dialog");
			const handle = f.tui.showOverlay(dialog);
			await f.open();
			expect(f.tui.getFocusedComponent()).toBe(dialog);
			expect(handle.isHidden()).toBe(false);
			handle.hide();
		} finally { f.tui.stop(); }
	});

	test("regular mode reports the requirement without changing focus", async () => {
		const f = fixture(false);
		try {
			await f.open();
			expect(f.notices).toEqual(["Transcript navigation needs Pi 1.0 fullscreen mode."]);
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
			expect(f.tui.hasOverlay()).toBe(false);
		} finally { f.tui.stop(); }
	});
});

describe("native message block boundaries", () => {
	initTheme("dark", false);
	const assistant = (content: any[], hidden = false) => new AssistantMessageComponent({
		role: "assistant", content, stopReason: "stop",
	} as any, hidden, getMarkdownTheme(), "Thinking...", 0);
	const text = (value: string) => ({ type: "text", text: value });
	const thinking = (value: string) => ({ type: "thinking", thinking: value });

	test.each([false, true])("separates text blocks and skips thinking, tool output, and unrelated Markdown (hidden: %s)", async (hidden) => {
		const content = new Container();
		content.addChild(new Markdown("header", 0, 0, getMarkdownTheme()));
		content.addChild(new UserMessageComponent("user block", getMarkdownTheme(), 0));
		content.addChild(assistant([thinking("private thought"), text("first reply"),
			text("second reply"), { type: "toolCall", id: "call", name: "read", arguments: {} },
			thinking("other thought"), text(""), text("  ")], hidden));
		const tool = new Container();
		tool.addChild(new Markdown("tool result", 0, 0, getMarkdownTheme()));
		content.addChild(tool);
		content.addChild(assistant([text("last reply")]));
		const f = fixture(true, content);
		try {
			const snapshot = readRenderedTranscript(f.tui)!;
			const blockTexts = snapshot.blocks.map((block) =>
				snapshot.lines.slice(block.startRow, block.endRow + 1).join("\n"));
			expect(blockTexts).toEqual(["user block", "first reply", "second reply", "last reply"]);
			expect(snapshot.height).toBe(7);
			const pending = f.open();
			f.render();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			expect(reader.getSelectedText()).toBe("last reply");
			expect(reader.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
			f.terminal.input("\x1b[A");
			expect(reader.getSelectedText()).toBe("second reply");
			f.terminal.input("\x1b[A");
			expect(reader.getSelectedText()).toBe("first reply");
			f.terminal.input("\x1b[12~");
			expect(reader.getSelectedText()).toBeUndefined();
			f.terminal.input("\x1b[1;2C");
			expect(reader.getSelectedText()).toBe("f");
			f.terminal.input("\x1b[12~");
			expect(reader.getSelectedText()).toBe("first reply");
			f.terminal.input("\x1b");
			await pending;
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
		} finally { f.tui.stop(); }
	});

	test("entry uses the original viewport and freezes both block text and boundaries", async () => {
		const content = new Container();
		content.addChild(new UserMessageComponent("question", getMarkdownTheme(), 0));
		const reply = assistant([text("visible reply")]);
		content.addChild(reply);
		content.addChild(new Text(Array.from({ length: 20 }, () => "tool result").join("\n"), 0, 0));
		content.addChild(assistant([text("offscreen reply")]));
		const f = fixture(true, content);
		try {
			f.scroll.scrollTo(0);
			f.render();
			const pending = f.open();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			expect(reader.getSelectedText()).toBe("visible reply");
			reply.updateContent({ role: "assistant", content: [text("new reply"), text("new block")], stopReason: "stop" } as any);
			f.render();
			expect(reader.getSelectedText()).toBe("visible reply");
			f.terminal.input("\x1b[B");
			expect(reader.getSelectedText()).toBe("offscreen reply");
			f.terminal.input("\x1b");
			await pending;
			expect(f.draft.text).toBe("keep this prompt");
		} finally { f.tui.stop(); }
	});

	test("tracks wrapped blocks at narrow widths without matching repeated text", async () => {
		const content = new Container();
		content.addChild(new UserMessageComponent("same words", getMarkdownTheme(), 0));
		content.addChild(assistant([thinking("same words"), text("same words"),
			text("a long reply that wraps across several lines in a narrow terminal")], true));
		const f = fixture(true, content);
		try {
			f.terminal.columns = 18;
			f.render();
			const snapshot = readRenderedTranscript(f.tui)!;
			expect(snapshot.blocks).toHaveLength(3);
			const last = snapshot.blocks.at(-1)!;
			expect(last.endRow - last.startRow).toBeGreaterThan(1);
			const pending = f.open();
			const reader = f.tui.getFocusedComponent() as TranscriptReader;
			expect(reader.getSelectedText()).toBe(snapshot.lines.slice(last.startRow, last.endRow + 1).join("\n"));
			f.terminal.input("\x1b[A");
			expect(reader.getSelectedText()).toBe("same words");
			f.terminal.input("\x1b[A");
			expect(reader.getSelectedText()).toBe("same words");
			f.terminal.input("\x1b");
			await pending;
		} finally { f.tui.stop(); }
	});
});
