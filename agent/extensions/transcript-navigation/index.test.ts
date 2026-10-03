import { describe, expect, test } from "bun:test";
import {
	CURSOR_MARKER, ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack,
	type OverlayHandle, type Terminal,
} from "@earendil-works/pi-tui";
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

function fixture(fullscreen = true) {
	const terminal = new MemoryTerminal();
	const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const transcript = new Text(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), 0, 0);
	const scroll = new ScrollView(transcript, { primary: true, follow: "end", scrollbar: "hidden" });
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
			f.terminal.input("\x1b[1;5H"); // Ctrl+Home
			f.terminal.input("\x1b[1;2C"); // Shift+Right
			expect(reader.getSelectedText()).toBe("l");
			f.terminal.input("\x1b[6~"); // PageDown must reach the reader, not the native viewport.
			expect(f.scroll.scrollTop).toBe(nativeTop);
			f.terminal.input("x");
			f.terminal.input("\x1b[200~paste\x1b[201~");
			f.terminal.input("\r");
			expect(f.promptInputs()).toBe(0);
			f.terminal.input("\x1b[12~"); // F2
			await pending;
			expect(f.tui.hasOverlay()).toBe(false);
			expect(f.tui.getFocusedComponent()).toBe(f.prompt);
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
			f.terminal.input("\x01");
			const selected = reader.getSelectedText();
			f.transcript.setText("new output");
			f.render();
			expect(reader.getSelectedText()).toBe(selected);
			f.terminal.input("\x1b");
			await pending;
			pending = f.open();
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
			f.terminal.input("\x01");
			f.render();
			const screen = (f.tui as TuiAltScreen).getScreenLines();
			expect(screen[0]).toContain("\x1b[32;1m");
			expect(screen[1]).toContain("\x1b[34m");
			expect((f.tui.getFocusedComponent() as TranscriptReader).getSelectedText()).toBe("heading\n  code");
			f.terminal.input("\x1b[12~");
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
