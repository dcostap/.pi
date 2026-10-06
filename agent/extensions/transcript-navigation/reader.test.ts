import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TranscriptReader, type TranscriptBlock } from "./reader.ts";
import { readRenderedTranscript, scrollRenderedTranscript } from "./snapshot.ts";

const keys = {
	left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B",
	home: "\x1b[H", end: "\x1b[F", pageUp: "\x1b[5~", pageDown: "\x1b[6~",
	shiftLeft: "\x1b[1;2D", shiftRight: "\x1b[1;2C", shiftDown: "\x1b[1;2B",
	shiftEnd: "\x1b[1;2F", ctrlHome: "\x1b[1;5H", ctrlEnd: "\x1b[1;5F",
	ctrlRight: "\x1b[1;5C", ctrlLeft: "\x1b[1;5D", ctrlShiftRight: "\x1b[1;6C",
	ctrlShiftEnd: "\x1b[1;6F", shiftPageDown: "\x1b[6;2~", f2: "\x1b[12~",
};

function mouse(type: TuiMouseEvent["type"], overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { type, button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 8,
		shift: false, alt: false, ctrl: false, ...overrides };
}

function fixture(lines = ["first line", "second line", "third"], rows = 8, top = 0, fails = false,
	styledLines?: string[], blocks: TranscriptBlock[] = [], blockMode = false, height?: number) {
	let closed = 0;
	let renders = 0;
	const copies: string[] = [];
	const ui = { terminal: { rows }, requestRender() { renders++; } };
	const reader = new TranscriptReader({ lines, styledLines, top, blocks, height }, ui, () => closed++, async (text) => {
		if (fails) throw new Error("clipboard unavailable");
		copies.push(text);
	});
	reader.focused = true;
	if (!blockMode) reader.handleInput(keys.f2);
	const input = (...names: (keyof typeof keys)[]) => names.forEach((name) => reader.handleInput(keys[name]));
	const position = () => (reader as any).cursor;
	const screen = (width = 80) => reader.render(width).map(stripTerminalSequences);
	return { reader, input, position, copies, ui, screen, closed: () => closed, renders: () => renders };
}

function characterStyles(line: string) {
	let color = 39;
	let bold = false;
	let inverse = false;
	let underline = false;
	const characters: { text: string; color: number; bold: boolean; inverse: boolean; underline: boolean }[] = [];
	for (const part of line.split(/(\x1b\[[\d;]*m)/g)) {
		if (part.startsWith("\x1b[")) {
			for (const code of part.slice(2, -1).split(";").map(Number)) {
				if (code === 0) { color = 39; bold = false; inverse = false; underline = false; }
				if (code >= 30 && code <= 39) color = code;
				if (code === 1 || code === 22) bold = code === 1;
				if (code === 7 || code === 27) inverse = code === 7;
				if (code === 4 || code === 24) underline = code === 4;
			}
		} else {
			for (const text of stripTerminalSequences(part)) characters.push({ text, color, bold, inverse, underline });
		}
	}
	return characters;
}

describe("transcript reader", () => {
	test("moves by character, line, page, and document", () => {
		const f = fixture(Array.from({ length: 20 }, (_, i) => `row ${i}`), 5);
		f.input("right", "right", "down");
		expect(f.position()).toEqual({ row: 1, col: 2 });
		f.input("end");
		expect(f.position().col).toBe(5);
		f.input("home", "pageDown");
		expect(f.position()).toEqual({ row: 5, col: 0 });
		f.input("pageUp", "ctrlEnd");
		expect(f.position()).toEqual({ row: 19, col: 6 });
		f.input("ctrlHome");
		expect(f.position()).toEqual({ row: 0, col: 0 });
	});

	test("selects characters with exclusive end boundaries", () => {
		const f = fixture(["abcdef"]);
		f.input("right", "shiftRight", "shiftRight");
		expect(f.reader.getSelectedText()).toBe("bc");
		f.input("shiftLeft");
		expect(f.reader.getSelectedText()).toBe("b");
	});

	test("selects across rows in either direction", () => {
		const f = fixture(["abc", "def"]);
		f.input("right", "shiftDown");
		expect(f.reader.getSelectedText()).toBe("bc\nd");
		f.input("ctrlEnd", "shiftLeft", "shiftLeft");
		expect(f.reader.getSelectedText()).toBe("ef");
	});

	test("plain left/right collapse selection", () => {
		const f = fixture(["abcdef"]);
		f.input("right", "shiftRight", "shiftRight", "left");
		expect(f.position().col).toBe(1);
		expect(f.reader.getSelectedText()).toBeUndefined();
		f.input("shiftRight", "shiftRight", "right");
		expect(f.position().col).toBe(3);
	});

	test("supports word movement and Ctrl+Shift selection", () => {
		const f = fixture(["hello world"]);
		f.input("ctrlShiftRight");
		expect(f.reader.getSelectedText()).toBe("hello");
		f.input("ctrlRight");
		expect(f.position().col).toBe(11);
		f.input("ctrlLeft");
		expect(f.position().col).toBe(6);
	});

	test("supports Home/End, page, and document selection", () => {
		const f = fixture(["abc", "def", "ghi", "jkl"], 3);
		f.input("right", "shiftEnd");
		expect(f.reader.getSelectedText()).toBe("bc");
		f.input("ctrlHome", "shiftPageDown");
		expect(f.reader.getSelectedText()).toBe("abc\ndef\n");
		f.input("ctrlHome", "ctrlShiftEnd");
		expect(f.reader.getSelectedText()).toBe("abc\ndef\nghi\njkl");
	});

	test("moves over complete graphemes", () => {
		const f = fixture(["a👨‍👩‍👧‍👦e\u0301中"]);
		f.input("right", "shiftRight");
		expect(f.reader.getSelectedText()).toBe("👨‍👩‍👧‍👦");
		f.input("right", "shiftRight");
		expect(f.reader.getSelectedText()).toBe("e\u0301");
		f.input("right", "shiftRight");
		expect(f.reader.getSelectedText()).toBe("中");
	});

	test("keeps the preferred terminal column across short and wide rows", () => {
		const f = fixture(["abcd", "x", "中文ab"]);
		f.input("end", "down");
		expect(f.position().col).toBe(1);
		f.input("down");
		expect(f.position().col).toBe(2);
	});

	test("crosses row boundaries with left/right", () => {
		const f = fixture(["abc", "def"]);
		f.input("end", "right");
		expect(f.position()).toEqual({ row: 1, col: 0 });
		f.input("left");
		expect(f.position()).toEqual({ row: 0, col: 3 });
	});

	test("ignores edits, submission, paste, and key releases", () => {
		const f = fixture(["abc"]);
		f.input("shiftRight");
		for (const input of ["x", "\r", "\x7f", "\x1b[3~", "\x1b[200~paste\x1b[201~", "\x1b[57362;1:3u"]) {
			f.reader.handleInput(input);
		}
		expect(f.reader.getSelectedText()).toBe("a");
		expect(f.position()).toEqual({ row: 0, col: 1 });
	});

	test("copies selected text, not unselected text", async () => {
		const f = fixture(["abc", "def"]);
		f.reader.handleInput("\x03");
		expect(f.copies).toEqual([]);
		f.reader.handleInput("\x01");
		f.reader.handleInput("\x03");
		await Promise.resolve();
		expect(f.copies).toEqual(["abc\ndef"]);
		expect(f.screen().at(-1)).toContain("Copied");
	});

	test("reports clipboard failure without losing selection", async () => {
		const f = fixture(["abc"], 8, 0, true);
		f.input("shiftRight");
		f.reader.handleInput("\x03");
		await Promise.resolve();
		expect(f.reader.getSelectedText()).toBe("a");
		expect(f.screen().at(-1)).toContain("Copy failed");
	});

	test("F2 and Escape return from caret mode before Escape closes", () => {
		const f = fixture();
		f.input("f2");
		expect(f.closed()).toBe(0);
		f.reader.handleInput("\x1b");
		expect(f.closed()).toBe(1);
		const g = fixture();
		g.reader.handleInput("\x1b");
		expect(g.closed()).toBe(0);
		g.reader.handleInput("\x1b");
		expect(g.closed()).toBe(1);
	});

	test("snapshot does not change when the live transcript changes", () => {
		const lines = ["old"];
		const f = fixture(lines);
		lines[0] = "new";
		lines.push("output");
		f.reader.handleInput("\x01");
		expect(f.reader.getSelectedText()).toBe("old");
	});

	test("scrolls to keep the cursor visible and starts at the live viewport", () => {
		const f = fixture(Array.from({ length: 20 }, (_, i) => `row ${i}`), 5, 10);
		expect(f.screen()[0]).toBe("row 10" + " ".repeat(74));
		f.input("ctrlEnd");
		expect(f.screen()[3]?.trim()).toBe("row 19");
	});

	test("renders bounded lines and a cursor after resize", () => {
		const f = fixture(["abcdefghij", "中文👨‍👩‍👧‍👦"]);
		f.input("end");
		f.ui.terminal.rows = 3;
		const rendered = f.reader.render(4);
		expect(rendered).toHaveLength(3);
		expect(rendered.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(4);
		f.input("down");
		for (const line of f.reader.render(1)) expect(visibleWidth(line)).toBeLessThanOrEqual(1);
	});

	test("empty transcripts remain safe", () => {
		const f = fixture([], 1, 100);
		f.input("left", "right", "up", "down", "ctrlEnd");
		expect(f.reader.render(1)).toHaveLength(1);
		expect(f.position()).toEqual({ row: 0, col: 0 });
	});

	test("keeps source colors and styles during selection, including embedded resets", () => {
		const f = fixture(["abcdef"], 8, 0, false, ["\x1b[31;1mab\x1b[0;34mcd\x1b[0mef"]);
		f.reader.focused = false;
		f.input("shiftRight", "shiftRight", "shiftRight");
		expect(characterStyles(f.reader.render(20)[0]!).slice(0, 6)).toEqual([
			{ text: "a", color: 31, bold: true, inverse: true, underline: false },
			{ text: "b", color: 31, bold: true, inverse: true, underline: false },
			{ text: "c", color: 34, bold: false, inverse: true, underline: false },
			{ text: "d", color: 34, bold: false, inverse: false, underline: false },
			{ text: "e", color: 39, bold: false, inverse: false, underline: false },
			{ text: "f", color: 39, bold: false, inverse: false, underline: false },
		]);
		expect(f.reader.getSelectedText()).toBe("abc");
	});

	test("keeps underline and color after the caret, without styling the line padding", () => {
		const f = fixture(["abc"], 8, 0, false, ["\x1b[32;4mabc\x1b[0m"]);
		f.input("right");
		const styles = characterStyles(f.reader.render(8)[0]!);
		expect(styles[0]).toMatchObject({ color: 32, underline: true, inverse: false });
		expect(styles[1]).toMatchObject({ color: 32, underline: true, inverse: true });
		expect(styles[2]).toMatchObject({ color: 32, underline: true, inverse: false });
		expect(styles[3]).toMatchObject({ color: 39, underline: false, inverse: false });
	});

	test("keeps background fill from the rendered line", () => {
		const f = fixture(["abc"], 8, 0, false, ["\x1b[44mabc   \x1b[0m"]);
		f.reader.focused = false;
		const rendered = f.reader.render(10)[0]!;
		expect(rendered).toContain("\x1b[44m");
		expect(stripTerminalSequences(rendered)).toBe("abc       ");
		f.reader.handleInput("\x01");
		expect(f.reader.getSelectedText()).toBe("abc");
	});

	test("copies Unicode text without source styles or hyperlink controls", async () => {
		const f = fixture(["中文 link"], 8, 0, false,
			["\x1b[38;2;120;150;180m中文 \x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b[0m"]);
		f.reader.handleInput("\x01");
		f.reader.handleInput("\x03");
		await Promise.resolve();
		expect(f.copies).toEqual(["中文 link"]);
		const rendered = f.reader.render(30)[0]!;
		expect(rendered).toContain("\x1b[38;2;120;150;180m");
		expect(rendered).toContain("\x1b]8;;https://example.com\x07");
	});

	test("keeps styles and cursor placement after horizontal clipping", () => {
		const f = fixture(["abcdefghij"], 8, 0, false, ["\x1b[35;1mabcdefghij\x1b[0m"]);
		f.input("end");
		const rendered = f.reader.render(4)[0]!;
		expect(rendered).toContain(CURSOR_MARKER);
		expect(characterStyles(rendered)[0]).toMatchObject({ text: "h", color: 35, bold: true });
		expect(visibleWidth(rendered)).toBe(4);
	});

	test("uses the terminal cursor without a drawn caret in caret mode when enabled", () => {
		const f = fixture(["abc"], 8, 0, false, ["\x1b[32;4mabc\x1b[0m"],
			[{ startRow: 0, endRow: 0 }], false);
		let hardwareCursor = true;
		Object.assign(f.ui, { getShowHardwareCursor: () => hardwareCursor });
		const rendered = f.reader.render(10)[0]!;
		expect(rendered).toContain(CURSOR_MARKER);
		expect(characterStyles(rendered).slice(0, 3)).toEqual([
			{ text: "a", color: 32, bold: false, inverse: false, underline: true },
			{ text: "b", color: 32, bold: false, inverse: false, underline: true },
			{ text: "c", color: 32, bold: false, inverse: false, underline: true },
		]);
		hardwareCursor = false;
		expect(characterStyles(f.reader.render(10)[0]!)[0]).toMatchObject({ inverse: true, underline: true });
	});

	test("hardware cursor does not remove text selection or highlight end-of-line padding", () => {
		const f = fixture(["abc"]);
		Object.assign(f.ui, { getShowHardwareCursor: () => true });
		f.input("shiftRight");
		const rendered = f.reader.render(10)[0]!;
		expect(rendered).toContain(CURSOR_MARKER);
		expect(characterStyles(rendered)[0]).toMatchObject({ text: "a", inverse: true, underline: false });
		expect(characterStyles(rendered)[1]).toMatchObject({ text: "b", inverse: false, underline: false });
		expect(f.reader.getSelectedText()).toBe("a");
		f.input("end");
		const atEnd = f.reader.render(10)[0]!;
		expect(atEnd).toContain(CURSOR_MARKER);
		expect(characterStyles(atEnd).every((char) => !char.inverse && !char.underline)).toBe(true);
	});
});

describe("block selection", () => {
	const lines = ["user", "", "thinking", "reply one", "reply two", "tool result", "", "latest", "tail", "offscreen"];
	const blocks = [{ startRow: 0, endRow: 0 }, { startRow: 3, endRow: 4 },
		{ startRow: 7, endRow: 8 }, { startRow: 9, endRow: 9 }];
	const open = (rows = 6, top = 0, height?: number) => fixture(lines, rows, top, false, undefined, blocks, true, height);

	test("starts at the latest block in the original viewport, not the transcript end", () => {
		const f = open(10, 2, 4);
		expect(f.reader.getSelectedText()).toBe("reply one\nreply two");
		expect(f.reader.render(100).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
		expect(f.screen(100).at(-1)).toContain("Block 2/4");
	});

	test("Up and Down skip reasoning and tools and stop at both ends", () => {
		const f = open();
		expect(f.reader.getSelectedText()).toBe("reply one\nreply two");
		f.input("up", "up");
		expect(f.reader.getSelectedText()).toBe("user");
		f.input("down", "down");
		expect(f.reader.getSelectedText()).toBe("latest\ntail");
		f.input("down", "down");
		expect(f.reader.getSelectedText()).toBe("offscreen");
	});

	test("ignores caret movements, select-all, edits, and key releases in block mode", () => {
		const f = open();
		f.input("right", "left", "home", "end", "pageDown", "shiftDown", "ctrlEnd");
		for (const data of ["\x01", "x", "\r", "\x7f", "\x1b[200~paste\x1b[201~", "\x1b[57352;1:3u"]) {
			f.reader.handleInput(data);
		}
		expect(f.reader.getSelectedText()).toBe("reply one\nreply two");
	});

	test("F2 replaces the selection strip with a caret at the block start", () => {
		const f = open();
		expect(f.reader.render(100).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
		f.input("f2");
		expect(f.reader.getSelectedText()).toBeUndefined();
		expect(f.position()).toEqual({ row: 3, col: 0 });
		expect(f.reader.render(100).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		f.input("shiftRight");
		expect(f.reader.getSelectedText()).toBe("r");
	});

	test("caret movement can leave the block; Escape selects the containing or closest block", () => {
		const f = open();
		f.input("f2", "ctrlEnd");
		f.reader.handleInput("\x1b");
		expect(f.reader.getSelectedText()).toBe("offscreen");
		expect(f.closed()).toBe(0);
		f.input("f2", "up", "up", "up"); // Blank row between tools and the latest reply.
		f.reader.handleInput("\x1b");
		expect(f.reader.getSelectedText()).toBe("latest\ntail");
		f.reader.handleInput("\x1b");
		expect(f.closed()).toBe(1);
	});

	test("F2 in caret mode selects the closest block and clears partial selection", () => {
		const f = open();
		f.input("f2", "up", "shiftRight", "f2");
		expect(f.reader.getSelectedText()).toBe("reply one\nreply two");
		expect(f.closed()).toBe(0);
		expect(f.reader.render(100).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
	});

	test("copies the whole tall block, shows its beginning, and keeps selection after resize", async () => {
		const text = Array.from({ length: 20 }, (_, i) => `row ${i}`);
		const sourceBlocks = [{ startRow: 1, endRow: 18 }];
		const f = fixture(text, 5, 10, false, undefined, sourceBlocks, true);
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(text.slice(1, 5));
		f.reader.handleInput("\x03");
		await Promise.resolve();
		expect(f.copies).toEqual([text.slice(1, 19).join("\n")]);
		f.ui.terminal.rows = 3;
		expect(f.reader.render(4)).toHaveLength(3);
		expect(f.reader.getSelectedText()).toBe(text.slice(1, 19).join("\n"));
		sourceBlocks[0]!.endRow = 2;
		text[1] = "new output";
		expect(f.reader.getSelectedText()).toStartWith("row 1\nrow 2");
	});

	test("centers selected blocks while moving up and down", () => {
		const text = Array.from({ length: 160 }, (_, i) => `row ${i}`);
		const f = fixture(text, 50, 0, false, undefined, [
			{ startRow: 24, endRow: 25 }, { startRow: 64, endRow: 65 }, { startRow: 104, endRow: 105 },
		], true);
		const check = (start: number, end: number) => {
			const screen = f.screen().slice(0, -1).map((line) => line.trim());
			const above = screen.indexOf(`row ${start}`);
			const below = screen.length - screen.indexOf(`row ${end}`) - 1;
			expect(above).toBe(Math.floor((screen.length - (end - start + 1)) / 2));
			expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
			const before = f.screen();
			expect(f.screen()).toEqual(before); // Rendering again must not move the viewport.
		};
		check(24, 25);
		f.input("down");
		check(64, 65);
		f.input("down");
		check(104, 105);
		f.input("up");
		check(64, 65);
		f.input("up");
		check(24, 25);
	});

	test("keeps a large block centered and fully visible after resize", () => {
		const text = Array.from({ length: 30 }, (_, i) => `row ${i}`);
		const f = fixture(text, 12, 10, false, undefined, [{ startRow: 10, endRow: 14 }], true);
		expect(f.screen()[0]?.trim()).toBe("row 7");
		f.ui.terminal.rows = 8; // Five selected rows plus one context row on each side.
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(
			text.slice(9, 16));
		f.ui.terminal.rows = 6; // No room for context, but the whole block still fits.
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(
			text.slice(10, 15));
		f.ui.terminal.rows = 5; // The block no longer fits. Keep its beginning at the top.
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(text.slice(10, 14));
		f.ui.terminal.rows = 12;
		expect(f.screen()[0]?.trim()).toBe("row 7");
		expect(f.reader.getSelectedText()).toBe(text.slice(10, 15).join("\n"));
	});

	test("aligns tall blocks at the top without moving between renders", () => {
		const text = Array.from({ length: 40 }, (_, i) => `row ${i}`);
		const f = fixture(text, 8, 20, false, undefined, [{ startRow: 10, endRow: 30 }], true);
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(text.slice(10, 17));
		const before = f.screen();
		expect(f.screen()).toEqual(before);
		f.ui.terminal.rows = 1;
		expect(f.screen()[0]?.trim()).toBe("row 10");
	});

	test("centers short blocks and top-aligns tall blocks when changing focus", () => {
		const text = Array.from({ length: 100 }, (_, i) => `row ${i}`);
		const f = fixture(text, 10, 20, false, undefined, [
			{ startRow: 20, endRow: 21 }, { startRow: 40, endRow: 59 },
		], true, 2);
		expect(f.reader.viewportTop).toBe(17);
		f.input("down");
		expect(f.reader.viewportTop).toBe(40);
		expect(f.screen().slice(0, -1).map((line) => line.trim())).toEqual(text.slice(40, 49));
		f.input("up");
		expect(f.reader.viewportTop).toBe(17);
	});

	test("keeps blocks as close to the center as transcript boundaries permit", () => {
		const text = Array.from({ length: 20 }, (_, i) => `row ${i}`);
		const f = fixture(text, 8, 0, false, undefined, [
			{ startRow: 0, endRow: 1 }, { startRow: 18, endRow: 19 },
		], true);
		expect(f.screen()[0]?.trim()).toBe("row 0");
		f.input("down");
		expect(f.screen()[0]?.trim()).toBe("row 13");
		expect(f.screen()[6]?.trim()).toBe("row 19");
		f.input("up");
		expect(f.screen()[0]?.trim()).toBe("row 0");
	});

	test("recalculates centered placement across small and large terminal heights", () => {
		const text = Array.from({ length: 200 }, (_, i) => `row ${i}`);
		const f = fixture(text, 8, 70, false, undefined, [{ startRow: 70, endRow: 72 }], true);
		for (const rows of [8, 20, 50, 90, 8]) {
			f.ui.terminal.rows = rows;
			const screen = f.screen().slice(0, -1).map((line) => line.trim());
			const above = Math.floor((rows - 1 - 3) / 2);
			expect(screen.indexOf("row 70")).toBe(above);
			expect(screen.indexOf("row 72")).toBe(above + 2);
			expect(f.reader.getSelectedText()).toBe(text.slice(70, 73).join("\n"));
		}
	});

	test("uses the closest block when only tool output is visible", () => {
		const f = open(3, 5, 1);
		expect(f.reader.getSelectedText()).toBe("reply one\nreply two");
	});

	test.each([false, true])("marks the left edge of every block line and keeps source styles (hardware cursor: %s)", (hardwareCursor) => {
		const f = fixture(["ab", "", "cd"], 8, 0, false,
			["\x1b[31mab\x1b[0m", "", "\x1b[34mcd\x1b[0m"], [{ startRow: 0, endRow: 2 }], true);
		Object.assign(f.ui, { getShowHardwareCursor: () => hardwareCursor });
		const rendered = f.reader.render(20);
		expect(characterStyles(rendered[0]!)[0]).toMatchObject({ color: 31, inverse: true, underline: false });
		expect(characterStyles(rendered[0]!)[1]).toMatchObject({ color: 31, inverse: false, underline: false });
		expect(characterStyles(rendered[1]!)[0]).toMatchObject({ inverse: true });
		expect(characterStyles(rendered[2]!)[0]).toMatchObject({ color: 34, inverse: true, underline: false });
		expect(characterStyles(rendered[2]!)[1]).toMatchObject({ color: 34, inverse: false, underline: false });
		expect(characterStyles(rendered[3]!)[0]).toMatchObject({ inverse: false });
		expect(rendered.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(0);
		expect(f.screen().slice(0, 3)).toEqual(["ab" + " ".repeat(78), " ".repeat(80), "cd" + " ".repeat(78)]);
		expect(f.reader.getSelectedText()).toBe("ab\n\ncd");
		f.reader.focused = false;
		expect(f.reader.render(20).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
		expect(characterStyles(f.reader.render(20)[0]!).every((char) => !char.inverse)).toBe(true);
	});

	test("keeps the selection strip bounded when scrolling a tall block", () => {
		const text = Array.from({ length: 30 }, (_, i) => `row ${i}`);
		const f = fixture(text, 8, 0, false, undefined, [{ startRow: 4, endRow: 20 }], true);
		expect(f.reader.render(80).slice(0, -1).every((line) => characterStyles(line)[0]?.inverse)).toBe(true);
		f.reader.handleMouse(mouse("wheel", { wheelDelta: 14 }));
		const rendered = f.reader.render(80);
		expect(f.reader.viewportTop).toBe(18);
		expect(rendered.slice(0, 3).every((line) => characterStyles(line)[0]?.inverse)).toBe(true);
		expect(rendered.slice(3, -1).every((line) => !characterStyles(line)[0]?.inverse)).toBe(true);
		expect(f.reader.getSelectedText()).toBe(text.slice(4, 21).join("\n"));
	});

	test("preserves full-width text, padding, and wide graphemes in the selection strip", () => {
		const f = fixture([" abc", "中ab", "e\u0301abc"], 8, 0, false, undefined,
			[{ startRow: 0, endRow: 2 }], true);
		const rendered = f.reader.render(4);
		expect(rendered.slice(0, 3).map(stripTerminalSequences)).toEqual([" abc", "中ab", "e\u0301abc"]);
		for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(4);
		expect(characterStyles(rendered[0]!)[1]?.inverse).toBe(false);
		expect(characterStyles(rendered[1]!)[1]?.inverse).toBe(false);
		expect(f.reader.getSelectedText()).toBe(" abc\n中ab\ne\u0301abc");
	});

	test("reports the latest viewport even when navigation has not rendered", () => {
		const text = Array.from({ length: 100 }, (_, i) => `row ${i}`);
		const f = fixture(text, 8, 0, false, undefined, [
			{ startRow: 2, endRow: 3 }, { startRow: 50, endRow: 51 },
		], true);
		f.reader.render(80);
		f.input("down");
		expect(f.reader.viewportTop).toBe(48);
		expect(f.screen()[0]?.trim()).toBe("row 48");
	});

	test("no eligible blocks stays safe and still permits caret navigation", () => {
		const f = fixture(["tool output"], 1, 0, false, undefined, [], true);
		expect(f.reader.getSelectedText()).toBeUndefined();
		f.input("up", "down");
		f.reader.handleInput("\x03");
		expect(f.copies).toEqual([]);
		f.input("f2", "shiftRight");
		expect(f.reader.getSelectedText()).toBe("t");
	});
});

describe("mouse navigation and copying", () => {
	test.each([false, true])("wheel scrolls without changing selection or moving back on render (blocks: %s)", (blockMode) => {
		const lines = Array.from({ length: 100 }, (_, i) => `row ${i}`);
		const f = fixture(lines, 8, 40, false, undefined, [{ startRow: 40, endRow: 41 }], blockMode);
		if (!blockMode) f.input("shiftRight");
		f.reader.render(80);
		const before = f.reader.viewportTop;
		const selected = f.reader.getSelectedText();
		const cursor = { ...f.position() };
		expect(f.reader.handleMouse(mouse("wheel", { wheelDelta: 12 }))).toEqual({ handled: true });
		expect(f.reader.viewportTop).toBe(before + 12);
		f.reader.render(80);
		f.reader.render(80);
		expect(f.reader.viewportTop).toBe(before + 12);
		expect(f.reader.getSelectedText()).toBe(selected);
		expect(f.position()).toEqual(cursor);
		f.reader.handleInput("\x1b");
		expect(f.reader.viewportTop).toBe(before + 12);
		if (!blockMode) f.reader.handleInput("\x1b");
		expect(f.closed()).toBe(1);
	});

	test("wheel clamps to transcript limits and keyboard navigation restores the caret", () => {
		const f = fixture(Array.from({ length: 20 }, (_, i) => `row ${i}`), 5, 10);
		f.reader.handleMouse(mouse("wheel", { wheelDelta: -100 }));
		expect(f.reader.viewportTop).toBe(0);
		f.reader.handleMouse(mouse("wheel", { wheelDelta: 100 }));
		expect(f.reader.viewportTop).toBe(16);
		f.ui.terminal.rows = 8;
		expect(f.reader.viewportTop).toBe(13);
		f.input("up");
		expect(f.reader.viewportTop).toBe(9);
	});

	test("right-click copies a whole block or partial caret selection once, but never pastes", async () => {
		const f = fixture(["abc", "def"], 8, 0, false, undefined, [{ startRow: 0, endRow: 1 }], true);
		for (const type of ["press", "release", "click"] as const) {
			expect(f.reader.handleMouse(mouse(type, { button: "right" }))?.handled).toBe(true);
		}
		expect(f.copies).toEqual(["abc\ndef"]);
		f.input("f2", "shiftRight");
		f.reader.handleMouse(mouse("press", { button: "right" }));
		await Promise.resolve();
		expect(f.copies).toEqual(["abc\ndef", "a"]);
		expect(f.reader.getSelectedText()).toBe("a");
		expect(f.screen().at(-1)).toContain("Copied");
		f.input("right");
		f.reader.handleMouse(mouse("press", { button: "right" }));
		expect(f.copies).toHaveLength(2);
		expect(f.reader.handleMouse(mouse("press", { button: "left" }))).toBeUndefined();
		expect(f.reader.handleMouse(mouse("press", { button: "right", ctrl: true }))).toBeUndefined();
	});

	test.each([false, true])("native mouse selection takes priority and follows automatic copy (%s)", (autoCopy) => {
		const f = fixture(["abc"], 8, 0, false, undefined, [{ startRow: 0, endRow: 0 }], true);
		let nativeCopies = 0;
		Object.assign(f.ui, {
			hasActiveSelection: () => true,
			getCopyOnSelect: () => autoCopy,
			copyActiveSelectionToClipboard: async () => { nativeCopies++; return true; },
		});
		f.reader.handleMouse(mouse("press", { button: "right" }));
		expect(nativeCopies).toBe(autoCopy ? 0 : 1);
		expect(f.copies).toEqual([]);
	});

	test("right-click reports clipboard failure and keeps selection", async () => {
		const f = fixture(["abc"], 8, 0, true, undefined, [{ startRow: 0, endRow: 0 }], true);
		f.reader.handleMouse(mouse("press", { button: "right" }));
		await Promise.resolve();
		expect(f.screen().at(-1)).toContain("Copy failed");
		expect(f.reader.getSelectedText()).toBe("abc");
	});
});

describe("rendered transcript access", () => {
	test("restores scroll through the native API and accounts for a header", () => {
		const calls: unknown[] = [];
		const scroll = { scrollTop: 0, scrollTo: (...args: unknown[]) => calls.push(args) };
		const tui = { mode: "fullscreen", currentLayout: {
			primaryScrollView: scroll, root: { children: [{ scrollView: scroll, children: [],
				rect: { y: 2, height: 8 } }] },
		} };
		scrollRenderedTranscript(tui, 20);
		expect(calls).toEqual([[22, { disableFollow: true }]]);
		scrollRenderedTranscript({ mode: "regular" }, 20);
		scrollRenderedTranscript({}, 20);
		expect(calls).toHaveLength(1);
	});

	test("reads only the primary scroll view and keeps styles separately from plain text", () => {
		const scroll = { scrollTop: 4 };
		const secondary = { scrollTop: 0 };
		const snapshot = readRenderedTranscript({ mode: "fullscreen", currentLayout: {
			primaryScrollView: scroll,
			root: { children: [
				{ scrollView: secondary, scrollContentLines: ["not transcript"], children: [] },
				{ children: [{ scrollView: scroll, scrollContentLines: ["\x1b[31mred\x1b[0m  ",
					"\x1b]8;;https://example.com\x07link\x1b]8;;\x07", "\x1b_Gimage\x1b\\"], children: [] }] },
			] },
		} });
		expect(snapshot).toEqual({ lines: ["red", "link", "[image]"], styledLines: [
			"\x1b[31mred\x1b[0m  ", "\x1b]8;;https://example.com\x07link\x1b]8;;\x07", "[image]",
		], top: 4, height: undefined, blocks: [] });
	});

	test("removes cursor and shell controls, but keeps SGR styles and both hyperlink endings", () => {
		const scroll = { scrollTop: 0 };
		const snapshot = readRenderedTranscript({ mode: "fullscreen", currentLayout: {
			primaryScrollView: scroll, root: { scrollView: scroll, children: [], scrollContentLines: [
				`\x1b]133;A\x07\x1b[2J\x1b[1;38:2::1:2:3m${CURSOR_MARKER}text\x1b[m`,
				"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
			] },
		} });
		expect(snapshot?.lines).toEqual(["text", "link"]);
		expect(snapshot?.styledLines).toEqual([
			"\x1b[1;38:2::1:2:3mtext\x1b[m", "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
		]);
	});

	test("rejects regular mode and unavailable buffers", () => {
		expect(readRenderedTranscript({ mode: "regular" })).toBeUndefined();
		expect(readRenderedTranscript({ mode: "fullscreen" })).toBeUndefined();
		expect(readRenderedTranscript({ mode: "fullscreen", currentLayout: {
			primaryScrollView: { scrollTop: 0 }, root: { children: [] },
		} })).toBeUndefined();
	});
});
