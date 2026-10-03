import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TranscriptReader } from "./reader.ts";
import { readRenderedTranscript } from "./snapshot.ts";

const keys = {
	left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B",
	home: "\x1b[H", end: "\x1b[F", pageUp: "\x1b[5~", pageDown: "\x1b[6~",
	shiftLeft: "\x1b[1;2D", shiftRight: "\x1b[1;2C", shiftDown: "\x1b[1;2B",
	shiftEnd: "\x1b[1;2F", ctrlHome: "\x1b[1;5H", ctrlEnd: "\x1b[1;5F",
	ctrlRight: "\x1b[1;5C", ctrlLeft: "\x1b[1;5D", ctrlShiftRight: "\x1b[1;6C",
	ctrlShiftEnd: "\x1b[1;6F", shiftPageDown: "\x1b[6;2~", f2: "\x1b[12~",
};

function fixture(lines = ["first line", "second line", "third"], rows = 8, top = 0, fails = false, styledLines?: string[]) {
	let closed = 0;
	let renders = 0;
	const copies: string[] = [];
	const ui = { terminal: { rows }, requestRender() { renders++; } };
	const reader = new TranscriptReader({ lines, styledLines, top }, ui, () => closed++, async (text) => {
		if (fails) throw new Error("clipboard unavailable");
		copies.push(text);
	});
	reader.focused = true;
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

	test("F2 and Escape close the reader", () => {
		const f = fixture();
		f.input("f2");
		f.reader.handleInput("\x1b");
		expect(f.closed()).toBe(2);
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
});

describe("rendered transcript access", () => {
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
		], top: 4 });
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
