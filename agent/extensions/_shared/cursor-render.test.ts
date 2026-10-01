import { describe, expect, test } from "bun:test";
import { keepCursorInRender } from "./cursor-render.ts";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";
const POSITION = "\x1b[4;7H";
const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";

function fixture(mode = "regular", hardware = true) {
	const writes: string[] = [];
	const terminal = {
		write(data: string) { writes.push(data); },
		// Pi writes visibility directly to stdout, outside terminal.write().
		showCursor() { writes.push(SHOW); },
		hideCursor() { writes.push(HIDE); },
	};
	const tui = {
		mode,
		getShowHardwareCursor: () => hardware,
		terminal,
		doRender() {
			this.terminal.write(BEGIN + "text" + END);
			this.terminal.write(POSITION);
			this.terminal.showCursor();
		},
	};
	return { tui, writes, output: () => writes.join("") };
}

describe("cursor render", () => {
	test("ends the screen update after cursor placement and visibility", () => {
		const { tui, output } = fixture();
		keepCursorInRender(tui);
		tui.doRender();
		expect(output()).toBe(BEGIN + "text" + POSITION + SHOW + END);
	});

	test("keeps a covered cursor hidden inside the screen update", () => {
		const { tui, output } = fixture();
		tui.doRender = () => {
			tui.terminal.write(BEGIN + "dialog" + END);
			tui.terminal.hideCursor();
		};
		keepCursorInRender(tui);
		tui.doRender();
		expect(output()).toBe(BEGIN + "dialog" + HIDE + END);
	});

	test("passes cursor-only movement through without a screen update", () => {
		const { tui, output } = fixture();
		tui.doRender = () => {
			tui.terminal.write(POSITION);
			tui.terminal.showCursor();
		};
		keepCursorInRender(tui);
		tui.doRender();
		expect(output()).toBe(POSITION + SHOW);
	});

	test("handles every split in the screen update sequences", () => {
		for (let split = 1; split < END.length; split++) {
			const { tui, output } = fixture();
			tui.doRender = () => {
				for (const sequence of [BEGIN, END]) {
					tui.terminal.write(sequence.slice(0, split));
					tui.terminal.write(sequence.slice(split));
				}
				tui.terminal.write(POSITION);
				tui.terminal.showCursor();
			};
			keepCursorInRender(tui);
			tui.doRender();
			expect(output()).toBe(BEGIN + POSITION + SHOW + END);
		}
	});

	test("passes unrelated escape sequences through unchanged", () => {
		const { tui, output } = fixture();
		const text = "\x1b[31mred\x1b[0m\x1b[?2026$p";
		tui.doRender = () => {
			for (const character of BEGIN + text + END + POSITION) tui.terminal.write(character);
		};
		keepCursorInRender(tui);
		tui.doRender();
		expect(output()).toBe(BEGIN + text + POSITION + END);
	});

	test("restores terminal.write and ends an open update after an error", () => {
		const { tui, output } = fixture();
		const write = tui.terminal.write;
		tui.doRender = () => {
			tui.terminal.write(BEGIN + "text");
			throw new Error("render failed");
		};
		keepCursorInRender(tui);
		expect(() => tui.doRender()).toThrow("render failed");
		expect(tui.terminal.write).toBe(write);
		expect(output()).toBe(BEGIN + "text" + END);
	});

	test("does not alter fullscreen or hidden-cursor rendering", () => {
		for (const [mode, hardware] of [["fullscreen", true], ["regular", false]] as const) {
			const { tui, output } = fixture(mode, hardware);
			keepCursorInRender(tui);
			tui.doRender();
			expect(output()).toBe(BEGIN + "text" + END + POSITION + SHOW);
		}
	});

	test("restores rendering on cleanup and supports another installation", () => {
		const { tui, output } = fixture();
		const render = tui.doRender;
		const restore = keepCursorInRender(tui);
		restore();
		restore();
		expect(tui.doRender).toBe(render);
		const restoreAgain = keepCursorInRender(tui);
		tui.doRender();
		expect(output()).toBe(BEGIN + "text" + POSITION + SHOW + END);
		restoreAgain();
	});

	test("restores inherited methods without adding own properties", () => {
		const { tui, output } = fixture();
		const terminal = Object.create(tui.terminal);
		const renderer = Object.create(tui);
		renderer.terminal = terminal;
		const restore = keepCursorInRender(renderer);
		renderer.doRender();
		expect(Object.hasOwn(terminal, "write")).toBe(false);
		restore();
		expect(Object.hasOwn(renderer, "doRender")).toBe(false);
		expect(output()).toBe(BEGIN + "text" + POSITION + SHOW + END);
	});
});
