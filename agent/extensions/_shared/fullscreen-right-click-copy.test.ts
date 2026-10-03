import { afterEach, describe, expect, test } from "bun:test";
import { installRightClickCopy } from "./fullscreen-right-click-copy.ts";

interface Point {
	row: number;
	col: number;
	boundary?: boolean;
	scrollView?: { scrollTop: number };
}

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

function fixture() {
	class FakeTui {
		selection: { start: Point; end: Point } | undefined = {
			start: { row: 1, col: 2 }, end: { row: 1, col: 5 },
		};
		currentLayout?: {
			root: {
				rect: { x: number; y: number; width: number; height: number };
				clip: { x: number; y: number; width: number; height: number };
				children: [];
				scrollView: { scrollTop: number };
			};
		};
		selectionPressActive = false;
		mouseCapture?: object;
		mousePressTarget?: object;
		scrollbarDrag?: object;
		overlay = false;
		copies = 0;
		clears = 0;
		renders = 0;
		passed: unknown[] = [];
		flashes: string[] = [];
		copyResult: Promise<boolean> = Promise.resolve(true);
		handleMouseEvent(event: unknown) { this.passed.push(event); }
		hasOverlay() { return this.overlay; }
		getSelectionBounds() { return this.selection; }
		getSelectionSourceLine() { return "0123456789"; }
		getSelectionColumns(line: string, row: number, range: { start: Point; end: Point }) {
			return {
				start: row === range.start.row ? range.start.col : 0,
				end: row === range.end.row ? range.end.col + (range.end.boundary ? 0 : 1) : line.length,
			};
		}
		copyActiveSelectionToClipboard() { this.copies++; return this.copyResult; }
		clearTextSelection() { this.clears++; this.selection = undefined; }
		requestRender() { this.renders++; }
		flash(message: string) { this.flashes.push(message); }
	}
	const original = FakeTui.prototype.handleMouseEvent;
	const restore = installRightClickCopy(FakeTui.prototype);
	expect(restore).toBeFunction();
	restores.push(restore!);
	const tui = new FakeTui();
	const click = (x = 3, y = 1, button = 2, release = false) => tui.handleMouseEvent({ x, y, button, release });
	return { tui, click, restore: restore!, prototype: FakeTui.prototype, original };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("fullscreen right-click copy", () => {
	test("copies and clears only after the clipboard write succeeds", async () => {
		const { tui, click } = fixture();
		click();
		expect(tui.copies).toBe(1);
		expect(tui.clears).toBe(0);
		expect(tui.passed).toHaveLength(0);
		await settle();
		expect(tui.clears).toBe(1);
		expect(tui.renders).toBe(1);
	});

	test("keeps normal behavior outside the selection and with no selection", async () => {
		const { tui, click } = fixture();
		click(1); click(6); click(3, 0); click(3, 2); click(30);
		tui.selection = undefined;
		click();
		await settle();
		expect(tui.copies).toBe(0);
		expect(tui.passed).toHaveLength(6);
	});

	test("ignores release, motion, wheel, modifiers, and other buttons", () => {
		const { tui, click } = fixture();
		click(3, 1, 2, true);
		for (const button of [0, 1, 3, 6, 10, 18, 34, 64, 65]) click(3, 1, button);
		expect(tui.copies).toBe(0);
		expect(tui.passed).toHaveLength(10);
	});

	test("does not copy through an overlay or during a mouse gesture", () => {
		const { tui, click } = fixture();
		tui.overlay = true; click(); tui.overlay = false;
		tui.selectionPressActive = true; click(); tui.selectionPressActive = false;
		tui.mouseCapture = {}; click(); tui.mouseCapture = undefined;
		tui.mousePressTarget = {}; click(); tui.mousePressTarget = undefined;
		tui.scrollbarDrag = {}; click();
		expect(tui.copies).toBe(0);
		expect(tui.passed).toHaveLength(5);
	});

	test("handles multiline selection endpoints and blank cells", async () => {
		const { tui, click } = fixture();
		tui.selection = { start: { row: 1, col: 2 }, end: { row: 3, col: 5 } };
		click(1, 1); click(6, 3); click(10, 2);
		click(0, 2);
		await settle();
		expect(tui.copies).toBe(1);
		expect(tui.passed).toHaveLength(3);
	});

	test("uses exclusive word-selection boundaries", async () => {
		const { tui, click } = fixture();
		tui.selection!.end.boundary = true;
		click(5); click(4);
		await settle();
		expect(tui.copies).toBe(1);
		expect(tui.passed).toHaveLength(1);
	});

	test("uses scroll offsets, viewport position, and clipping", async () => {
		const { tui, click } = fixture();
		const scrollView = { scrollTop: 10 };
		tui.selection = {
			start: { row: 10, col: 2, scrollView }, end: { row: 10, col: 5, scrollView },
		};
		tui.currentLayout = {
			root: {
				rect: { x: 4, y: 3, width: 10, height: 4 },
				clip: { x: 7, y: 3, width: 7, height: 3 },
				children: [], scrollView,
			},
		};
		click(6, 3); // Selected content, but clipped out.
		click(7, 2); click(7, 7); click(14, 3); // Outside the viewport.
		click(7, 3);
		await settle();
		expect(tui.copies).toBe(1);
		expect(tui.passed).toHaveLength(4);
	});

	test("keeps the selection when the clipboard write fails", async () => {
		const { tui, click } = fixture();
		tui.copyResult = Promise.resolve(false);
		click();
		await settle();
		expect(tui.clears).toBe(0);
		expect(tui.passed).toHaveLength(0);
	});

	test("reports a thrown clipboard error without clearing or pasting", async () => {
		const { tui, click } = fixture();
		tui.copyResult = Promise.reject(new Error("clipboard unavailable"));
		click();
		await settle();
		expect(tui.clears).toBe(0);
		expect(tui.passed).toHaveLength(0);
		expect(tui.flashes).toEqual(["Copy failed"]);
	});

	test("does not clear a new selection while copying", async () => {
		const { tui, click } = fixture();
		click();
		tui.selection = { start: { row: 1, col: 2 }, end: { row: 1, col: 5 } };
		await settle();
		expect(tui.clears).toBe(0);
	});

	test("does not repeat a pending clipboard write", async () => {
		const { tui, click } = fixture();
		click(); click();
		await settle();
		expect(tui.copies).toBe(1);
		expect(tui.clears).toBe(1);
	});

	test("restores the handler and cancels pending clearing on cleanup", async () => {
		const { tui, click, restore, prototype, original } = fixture();
		click(); restore(); restore();
		await settle();
		expect(prototype.handleMouseEvent).toBe(original);
		expect(tui.clears).toBe(0);
	});

	test("replaces its patch on reload without adding wrappers", async () => {
		const { tui, click, restore, prototype, original } = fixture();
		const nextRestore = installRightClickCopy(prototype)!;
		restores.push(nextRestore);
		restore();
		click();
		await settle();
		expect(tui.copies).toBe(1);
		nextRestore();
		expect(prototype.handleMouseEvent).toBe(original);
	});

	test("does not overwrite another extension's later handler", () => {
		const { restore, prototype } = fixture();
		const laterHandler = () => {};
		prototype.handleMouseEvent = laterHandler;
		restore();
		expect(prototype.handleMouseEvent).toBe(laterHandler);
	});

	test("rejects an incompatible Pi version", () => {
		for (const prototype of [null, undefined, {}, { handleMouseEvent() {} }]) {
			expect(installRightClickCopy(prototype)).toBeUndefined();
		}
	});
});
