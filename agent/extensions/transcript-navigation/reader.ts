import { CURSOR_MARKER, isKeyRelease, parseKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type TranscriptSnapshot = { lines: string[]; styledLines?: string[]; top: number };
type Position = { row: number; col: number };
type Selection = { start: Position; end: Position };
type ReaderUI = { terminal: { rows: number }; requestRender(): void };

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
	private cursor: Position;
	private anchor: Position | undefined;
	private top: number;
	private left = 0;
	private preferredColumn: number;
	private message = "F2/Esc: prompt · Shift+arrows: select · Ctrl+C: copy";

	constructor(
		snapshot: TranscriptSnapshot,
		private readonly ui: ReaderUI,
		private readonly close: () => void,
		private readonly copy: (text: string) => Promise<void>,
		private readonly statusStyle: (text: string) => string = (text) => text,
	) {
		this.lines = snapshot.lines.length ? [...snapshot.lines] : [""];
		this.styledLines = snapshot.styledLines ? [...snapshot.styledLines] : this.lines;
		this.top = Math.max(0, Math.min(snapshot.top, this.lines.length - 1));
		this.cursor = { row: this.top, col: 0 };
		this.preferredColumn = 0;
	}

	private get pageHeight(): number {
		return Math.max(1, this.ui.terminal.rows - 1);
	}

	private selection(): Selection | undefined {
		if (!this.anchor || compare(this.anchor, this.cursor) === 0) return;
		return compare(this.anchor, this.cursor) < 0
			? { start: this.anchor, end: this.cursor }
			: { start: this.cursor, end: this.anchor };
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

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const key = parseKey(data);
		if (!key) return;
		if (key === "f2" || key === "escape") return this.close();
		if (key === "ctrl+c") {
			const text = this.getSelectedText();
			if (text !== undefined) {
				void this.copy(text).then(() => {
					this.message = "Copied · F2/Esc: prompt";
				}, () => {
					this.message = "Copy failed · Ctrl+C: retry · F2/Esc: prompt";
				}).finally(() => this.ui.requestRender());
			}
			return;
		}
		if (key === "ctrl+a") {
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
		const caretRow = this.focused && row === this.cursor.row;
		const caretStart = caretRow ? columnAt(this.cursor.col) : -1;
		const caretText = caretRow ? graphemes.segment(line.slice(this.cursor.col)).containing(0)?.segment : undefined;
		const caretEnd = caretStart + Math.max(1, visibleWidth(caretText ?? ""));
		const length = Math.max(visibleWidth(styled), caretRow ? caretEnd : 0);
		const selectedRow = range && row >= range.start.row && row <= range.end.row;
		const selectionStart = selectedRow ? (row === range.start.row ? columnAt(range.start.col) : 0) : -1;
		const selectionEnd = selectedRow ? (row === range.end.row ? columnAt(range.end.col) : length) : -1;
		const boundaries = new Set([0, length]);
		if (selectedRow) { boundaries.add(selectionStart); boundaries.add(selectionEnd); }
		if (caretRow) { boundaries.add(caretStart); boundaries.add(caretEnd); }
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
			rendered += caret || selected ? highlight(text, caret) : text;
		}
		return rendered;
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = this.pageHeight;
		this.top = Math.max(0, Math.min(this.top, this.lines.length - height));
		if (this.cursor.row < this.top) this.top = this.cursor.row;
		if (this.cursor.row >= this.top + height) this.top = this.cursor.row - height + 1;
		const cursorColumn = visibleWidth(this.lines[this.cursor.row]!.slice(0, this.cursor.col));
		if (cursorColumn < this.left) this.left = cursorColumn;
		if (cursorColumn >= this.left + width) this.left = cursorColumn - width + 1;

		const range = this.selection();
		const output: string[] = [];
		for (let row = this.top; row < this.top + height; row++) {
			const cropped = sliceByColumn(this.renderLine(row, range), this.left, width, true);
			output.push(cropped + "\x1b[0m\x1b]8;;\x07" + " ".repeat(Math.max(0, width - visibleWidth(cropped))));
		}
		if (this.ui.terminal.rows > 1) {
			output.push(this.statusStyle(truncateToWidth(`Transcript · ${this.cursor.row + 1}/${this.lines.length} · ${this.message}`, width, "")));
		}
		return output;
	}

	invalidate(): void {}
}
