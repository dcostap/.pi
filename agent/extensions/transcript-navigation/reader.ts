import {
	CURSOR_MARKER, isKeyRelease, parseKey, sliceByColumn, truncateToWidth, visibleWidth,
	type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type TranscriptBlock = { startRow: number; endRow: number };
export type TranscriptSnapshot = {
	lines: string[]; styledLines?: string[]; top: number; height?: number; blocks: TranscriptBlock[];
};
type Position = { row: number; col: number };
type Selection = { start: Position; end: Position };
type ReaderUI = {
	terminal: { rows: number }; requestRender(): void;
	getShowHardwareCursor?(): boolean;
	getCopyOnSelect?(): boolean;
	hasActiveSelection?(): boolean;
	copyActiveSelectionToClipboard?(): Promise<boolean>;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const compare = (a: Position, b: Position) => a.row - b.row || a.col - b.col;

function highlight(text: string, caret: boolean): string {
	const style = caret ? "\x1b[7;4m" : "\x1b[7m";
	// Source style changes can reset inverse and underline inside the selected text.
	return style + text.replace(/\x1b\[[\d;:]*m/g, `$&${style}`) + "\x1b[27m" + (caret ? "\x1b[24m" : "");
}

/** A fixed, read-only copy of the rendered transcript. Columns are UTF-16 offsets. */
export class TranscriptReader {
	focused = false;
	private readonly lines: string[];
	private readonly styledLines: string[];
	private readonly blocks: TranscriptBlock[];
	private mode: "block" | "caret" = "block";
	private blockIndex = -1;
	private cursor: Position;
	private anchor: Position | undefined;
	private top: number;
	private manualScroll = false;
	private left = 0;
	private preferredColumn: number;
	private message = "";

	constructor(
		snapshot: TranscriptSnapshot,
		private readonly ui: ReaderUI,
		private readonly close: () => void,
		private readonly copy: (text: string) => Promise<void>,
		private readonly statusStyle: (text: string) => string = (text) => text,
	) {
		this.lines = snapshot.lines.length ? [...snapshot.lines] : [""];
		this.styledLines = snapshot.styledLines ? [...snapshot.styledLines] : this.lines;
		this.blocks = snapshot.blocks.map((block) => ({ ...block }));
		this.top = Math.max(0, Math.min(snapshot.top, this.lines.length - 1));
		this.cursor = { row: this.top, col: 0 };
		this.preferredColumn = 0;
		const bottom = this.top + (snapshot.height ?? this.pageHeight) - 1;
		const visible = this.blocks.findLastIndex((block) => block.startRow <= bottom && block.endRow >= this.top);
		this.selectBlock(visible >= 0 ? visible : this.closestBlock(bottom));
	}

	private get pageHeight(): number {
		return Math.max(1, this.ui.terminal.rows - 1);
	}

	private selection(): Selection | undefined {
		if (this.mode === "block") {
			const block = this.blocks[this.blockIndex];
			if (!block) return;
			return { start: { row: block.startRow, col: 0 },
				end: { row: block.endRow, col: this.lines[block.endRow]!.length } };
		}
		if (!this.anchor || compare(this.anchor, this.cursor) === 0) return;
		return compare(this.anchor, this.cursor) < 0
			? { start: this.anchor, end: this.cursor }
			: { start: this.cursor, end: this.anchor };
	}

	private closestBlock(row: number): number {
		let closest = -1;
		let distance = Infinity;
		this.blocks.forEach((block, index) => {
			const gap = Math.max(block.startRow - row, row - block.endRow, 0);
			if (gap < distance) { closest = index; distance = gap; }
		});
		return closest;
	}

	private selectBlock(index: number): void {
		this.mode = "block";
		this.blockIndex = index;
		this.anchor = undefined;
		this.left = 0;
		this.manualScroll = false;
		this.message = "";
		const block = this.blocks[index];
		if (block) this.cursor = { row: block.startRow, col: 0 };
		this.preferredColumn = 0;
	}

	private get help(): string {
		return this.mode === "block"
			? "Up/Down: block · F2: caret · Esc: prompt · Ctrl+C: copy"
			: "F2/Esc: blocks · Shift+arrows: select · Ctrl+C: copy";
	}

	getSelectedText(): string | undefined {
		const range = this.selection();
		if (!range) return;
		return this.lines.slice(range.start.row, range.end.row + 1).map((line, index) => {
			const row = range.start.row + index;
			return line.slice(row === range.start.row ? range.start.col : 0,
				row === range.end.row ? range.end.col : line.length).trimEnd();
		}).join("\n");
	}

	private horizontal(direction: -1 | 1, word: boolean): void {
		const line = this.lines[this.cursor.row]!;
		const segments = [...(word ? words : graphemes).segment(line)];
		const segment = direction < 0
			? segments.reverse().find((part) => part.index < this.cursor.col && (!word || part.segment.trim()))
			: segments.find((part) => part.index + part.segment.length > this.cursor.col && (!word || part.segment.trim()));
		if (segment) {
			this.cursor.col = direction < 0 ? segment.index : segment.index + segment.segment.length;
		} else if (direction < 0 && this.cursor.row > 0) {
			this.cursor.row--;
			this.cursor.col = this.lines[this.cursor.row]!.length;
		} else if (direction > 0 && this.cursor.row < this.lines.length - 1) {
			this.cursor.row++;
			this.cursor.col = 0;
		} else {
			this.cursor.col = direction < 0 ? 0 : line.length;
		}
	}

	private vertical(delta: number): void {
		this.cursor.row = Math.max(0, Math.min(this.lines.length - 1, this.cursor.row + delta));
		let column = 0;
		this.cursor.col = 0;
		for (const part of graphemes.segment(this.lines[this.cursor.row]!)) {
			column += visibleWidth(part.segment);
			if (column > this.preferredColumn) break;
			this.cursor.col = part.index + part.segment.length;
		}
	}

	private copySelectedText(): void {
		const text = this.getSelectedText();
		if (text === undefined) return;
		void this.copy(text).then(() => {
			this.message = "Copied · ";
		}, () => {
			this.message = "Copy failed · Ctrl+C: retry · ";
		}).finally(() => this.ui.requestRender());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			// Pi already applies its configured speed, acceleration, and Alt multiplier.
			this.updateViewport();
			const delta = event.wheelDelta ?? 0;
			if (Number.isFinite(delta)) {
				this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - this.pageHeight),
					this.top + Math.trunc(delta)));
			}
			this.manualScroll = true;
			return { handled: true };
		}
		if (event.button !== "right" || event.shift || event.alt || event.ctrl) return;
		if (event.type === "press") {
			// Native mouse selection takes priority over the reader's keyboard selection.
			if (this.ui.hasActiveSelection?.()) {
				if (!this.ui.getCopyOnSelect?.()) void this.ui.copyActiveSelectionToClipboard?.();
			} else this.copySelectedText();
			return { handled: true };
		}
		if (event.type === "release" || event.type === "click") return { handled: true, render: false };
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const key = parseKey(data);
		if (!key) return;
		if (key === "f2" || key === "escape") {
			if (this.mode === "caret") {
				const manualScroll = this.manualScroll;
				this.selectBlock(this.closestBlock(this.cursor.row));
				this.manualScroll = manualScroll;
			} else if (key === "escape") return this.close();
			else {
				this.mode = "caret";
				this.anchor = undefined;
				this.message = "";
				this.manualScroll = false;
			}
			this.ui.requestRender();
			return;
		}
		if (key === "ctrl+c") {
			this.copySelectedText();
			return;
		}
		if (this.mode === "block") {
			if ((key === "up" || key === "down") && this.blocks.length) {
				this.selectBlock(Math.max(0, Math.min(this.blocks.length - 1,
					this.blockIndex + (key === "up" ? -1 : 1))));
				this.ui.requestRender();
			}
			return;
		}
		if (key === "ctrl+a") {
			this.manualScroll = false;
			this.anchor = { row: 0, col: 0 };
			this.cursor = { row: this.lines.length - 1, col: this.lines.at(-1)!.length };
			this.preferredColumn = visibleWidth(this.lines.at(-1)!);
			this.ui.requestRender();
			return;
		}

		const select = key.includes("shift+");
		const movement = key.replace("shift+", "");
		const horizontal = ["left", "right", "ctrl+left", "ctrl+right", "alt+left", "alt+right"].includes(movement);
		const vertical = ["up", "down", "pageUp", "pageDown"].includes(movement);
		if (!horizontal && !vertical && !["home", "end", "ctrl+home", "ctrl+end"].includes(movement)) return;
		this.manualScroll = false;

		if (select) this.anchor ??= { ...this.cursor };
		const range = this.selection();
		if (!select && range && (movement === "left" || movement === "right")) {
			this.cursor = { ...(movement === "left" ? range.start : range.end) };
		} else if (horizontal) {
			this.horizontal(movement.endsWith("left") ? -1 : 1, movement.includes("+"));
		} else if (vertical) {
			const delta = movement === "up" ? -1 : movement === "down" ? 1
				: movement === "pageUp" ? -this.pageHeight : this.pageHeight;
			this.vertical(delta);
		} else {
			if (movement === "ctrl+home") this.cursor.row = 0;
			if (movement === "ctrl+end") this.cursor.row = this.lines.length - 1;
			this.cursor.col = movement.endsWith("home") ? 0 : this.lines[this.cursor.row]!.length;
		}
		if (!select) this.anchor = undefined;
		if (!vertical) this.preferredColumn = visibleWidth(this.lines[this.cursor.row]!.slice(0, this.cursor.col));
		this.ui.requestRender();
	}

	private renderLine(row: number, range: Selection | undefined): string {
		const line = this.lines[row] ?? "";
		const styled = this.styledLines[row] ?? line;
		const columnAt = (offset: number) => visibleWidth(line.slice(0, offset));
		const caretRow = this.focused && this.mode === "caret" && row === this.cursor.row;
		const block = this.focused && this.mode === "block" ? this.blocks[this.blockIndex] : undefined;
		const blockRow = block && row >= block.startRow && row <= block.endRow;
		// Mark the first cell without replacing text or splitting a wide grapheme.
		const blockMarkerEnd = blockRow
			? Math.max(1, visibleWidth(graphemes.segment(line).containing(0)?.segment ?? "")) : 0;
		const caretStart = caretRow ? columnAt(this.cursor.col) : -1;
		const caretText = caretRow ? graphemes.segment(line.slice(this.cursor.col)).containing(0)?.segment : undefined;
		const caretEnd = caretStart + Math.max(1, visibleWidth(caretText ?? ""));
		const length = Math.max(visibleWidth(styled), caretRow ? caretEnd : 0, blockMarkerEnd);
		const selectedRow = range && row >= range.start.row && row <= range.end.row;
		const selectionStart = selectedRow ? (row === range.start.row ? columnAt(range.start.col) : 0) : -1;
		const selectionEnd = selectedRow ? (row === range.end.row ? columnAt(range.end.col) : length) : -1;
		const boundaries = new Set([0, length]);
		if (selectedRow) { boundaries.add(selectionStart); boundaries.add(selectionEnd); }
		if (caretRow) { boundaries.add(caretStart); boundaries.add(caretEnd); }
		if (blockRow) boundaries.add(blockMarkerEnd);
		const points = [...boundaries].sort((a, b) => a - b);
		let rendered = "";
		for (let index = 0; index < points.length - 1; index++) {
			const start = points[index]!;
			const end = points[index + 1]!;
			let text = sliceByColumn(styled, start, end - start, true);
			text += " ".repeat(Math.max(0, end - start - visibleWidth(text)));
			const caret = caretRow && start === caretStart;
			const selected = selectedRow && start >= selectionStart && start < selectionEnd;
			if (caret) rendered += CURSOR_MARKER;
			const drawCaret = caret && !this.ui.getShowHardwareCursor?.();
			const blockMarker = blockRow && start < blockMarkerEnd;
			rendered += drawCaret || selected || blockMarker ? highlight(text, drawCaret) : text;
		}
		return rendered;
	}

	private updateViewport(): void {
		const height = this.pageHeight;
		this.top = Math.max(0, Math.min(this.top, this.lines.length - height));
		if (this.manualScroll) return;
		const block = this.mode === "block" ? this.blocks[this.blockIndex] : undefined;
		if (block) {
			// Center blocks that fit. Align taller blocks with the viewport top.
			const blockHeight = block.endRow - block.startRow + 1;
			const margin = Math.max(0, Math.floor((height - blockHeight) / 2));
			this.top = Math.max(0, Math.min(block.startRow - margin, this.lines.length - height));
		} else {
			if (this.cursor.row < this.top) this.top = this.cursor.row;
			if (this.cursor.row >= this.top + height) this.top = this.cursor.row - height + 1;
		}
	}

	get viewportTop(): number {
		// Input can close the overlay before its next render.
		this.updateViewport();
		return this.top;
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = this.pageHeight;
		this.updateViewport();
		const cursorColumn = visibleWidth(this.lines[this.cursor.row]!.slice(0, this.cursor.col));
		if (cursorColumn < this.left) this.left = cursorColumn;
		if (cursorColumn >= this.left + width) this.left = cursorColumn - width + 1;

		// Block mode marks only the left edge. Caret mode highlights selected text.
		const range = this.mode === "caret" ? this.selection() : undefined;
		const output: string[] = [];
		for (let row = this.top; row < this.top + height; row++) {
			const cropped = sliceByColumn(this.renderLine(row, range), this.left, width, true);
			output.push(cropped + "\x1b[0m\x1b]8;;\x07" + " ".repeat(Math.max(0, width - visibleWidth(cropped))));
		}
		if (this.ui.terminal.rows > 1) {
			const location = this.mode === "block"
				? this.blockIndex < 0 ? "No text blocks" : `Block ${this.blockIndex + 1}/${this.blocks.length}`
				: `Caret ${this.cursor.row + 1}/${this.lines.length}`;
			output.push(this.statusStyle(truncateToWidth(`${location} · ${this.message}${this.help}`, width, "")));
		}
		return output;
	}

	invalidate(): void {}
}
