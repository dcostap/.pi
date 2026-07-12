/**
 * Selection Editor
 *
 * Adds editor-style selection behavior to pi's main prompt editor:
 * - Shift+Left / Shift+Right / Shift+Up / Shift+Down
 * - Ctrl+Shift+Left / Ctrl+Shift+Right (and Alt+Shift variants)
 * - Shift+Home / Shift+End
 * - Ctrl+Home / Ctrl+End
 * - Ctrl+Shift+Home / Ctrl+Shift+End
 * - Shift+PageUp / Shift+PageDown
 * - Ctrl+Z undo and Ctrl+Y redo
 * - Typing replaces selection
 * - Backspace/Delete/word-delete remove selection
 * - Escape clears selection first
 *
 * Notes:
 * - This intentionally leans on a few runtime editor internals via `as any`.
 *   It's a draft extension, but should be a solid starting point.
 * - Visual copy/cut integration is implemented for active selections:
 *   Ctrl+C copies, Ctrl+X cuts, Ctrl+A selects all.
 * - Ctrl+X with no selection cuts the current line.
 * - Ctrl+D duplicates the current line below and moves the cursor to it.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { copyToClipboard, CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Pos = { line: number; col: number };
type Range = { start: Pos; end: Pos };
type VisualLine = { logicalLine: number; startCol: number; length: number };
type EditorStateSnapshot = { lines: string[]; cursorLine: number; cursorCol: number };

type EditorInternals = {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastWidth: number;
	scrollOffset: number;
	autocompleteState: "regular" | "force" | null;
	autocompleteList?: { render(width: number): string[] };
	segment(text: string): Iterable<Intl.SegmentData>;
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	moveCursor(deltaLine: number, deltaCol: number): void;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	pageScroll(direction: -1 | 1): void;
	buildVisualLineMap(width: number): VisualLine[];
	findCurrentVisualLine(visualLines: VisualLine[]): number;
	insertCharacter(char: string, skipUndoCoalescing?: boolean): void;
	insertTextAtCursorInternal(text: string): void;
	cancelAutocomplete(): void;
	handlePaste(pastedText: string): void;
	undo(): void;
	history: string[];
	jumpMode: "forward" | "backward" | null;
};

const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";
const LARGE_PASTE_FILE_THRESHOLD = 5_000;
const PASTE_MARKER_LINE_THRESHOLD = 10;
const PASTE_MARKER_CHAR_THRESHOLD = 1_000;
const LARGE_PASTE_DIR = join(tmpdir(), "pi-paste-dumps");
const KEY_DEBUG_LOG = join(tmpdir(), "pi-selection-editor-keys.log");
const ENABLE_KEY_DEBUG_LOG = process.env.PI_SELECTION_EDITOR_KEY_DEBUG === "1";
const KEY_DEBUG_PREVIEW_CHARS = 160;

class SelectionEditor extends CustomEditor {
	private selectionAnchor: Pos | null = null;
	private customPasteChunks: string[] = [];
	private customPasteInProgress = false;
	private promptBufferIndex = -1;
	private promptBufferTexts = new Map<number, string>();
	private redoStack: EditorStateSnapshot[] = [];
	private basePushUndoSnapshot: (() => void) | null = null;

	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);

		// The base Editor already owns undo snapshots. Patch the runtime TS-private
		// method so every normal edit invalidates redo, while redo itself can still
		// push an undo snapshot through `basePushUndoSnapshot` without clearing the
		// remaining redo chain.
		this.basePushUndoSnapshot = this.i.pushUndoSnapshot.bind(this);
		this.i.pushUndoSnapshot = () => {
			this.redoStack.length = 0;
			this.basePushUndoSnapshot?.();
		};
	}

	private decodeTmuxPasteControls(text: string): string {
		return text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
			const codePoint = Number(code);
			if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
			if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
			return match;
		});
	}

	private normalizePastedFileContent(text: string): string {
		// Decode tmux's CSI-u control representation before filtering, matching
		// the base editor's paste handling for newlines and other control bytes.
		const decodedText = this.decodeTmuxPasteControls(text);
		return decodedText.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
	}

	private shouldDumpPasteToFile(pastedText: string): boolean {
		return pastedText.length > LARGE_PASTE_FILE_THRESHOLD;
	}

	private makeLargePasteFilePath(): string {
		mkdirSync(LARGE_PASTE_DIR, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
		return join(LARGE_PASTE_DIR, `paste-${timestamp}-${randomUUID().slice(0, 8)}.txt`);
	}

	private insertFilePathAtCursor(filePath: string, pushUndo: boolean): void {
		const normalizedPath = filePath.replace(/\\/g, "/");
		const fileReference = `@${normalizedPath}`;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
		const textToInsert = charBeforeCursor && !/\s/.test(charBeforeCursor) ? ` ${fileReference}` : fileReference;

		this.i.cancelAutocomplete();
		if (pushUndo) this.i.pushUndoSnapshot();
		this.i.insertTextAtCursorInternal(textToInsert);
		this.tui.requestRender();
	}

	private handleBracketedPaste(pastedText: string): boolean {
		if (!this.shouldDumpPasteToFile(pastedText)) return false;

		const fileContent = this.normalizePastedFileContent(pastedText);
		const filePath = this.makeLargePasteFilePath();
		writeFileSync(filePath, fileContent, "utf8");

		const hadSelection = this.hasSelection();
		if (hadSelection) this.deleteSelection(true);
		this.clearSelection();
		this.insertFilePathAtCursor(filePath, !hadSelection);
		return true;
	}

	private pasteWouldBecomeMarker(text: string): boolean {
		const cleanText = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		const filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
		return filteredText.split("\n").length > PASTE_MARKER_LINE_THRESHOLD || filteredText.length > PASTE_MARKER_CHAR_THRESHOLD;
	}

	private shouldWrapPasteInMarkdownSeparators(text: string): boolean {
		if (this.hasSelection()) return false;
		if (!this.pasteWouldBecomeMarker(text)) return false;
		return (this.state.lines[this.state.cursorLine] ?? "").trim().length === 0;
	}

	private textWithMarkdownSeparators(text: string): string {
		const normalizedText = text.replace(/\r\n?/g, "\n");
		return `---\n${normalizedText}\n---`;
	}

	private handleCustomPasteInput(data: string): boolean {
		if (data.includes("\x1b[200~")) {
			this.customPasteInProgress = true;
			this.customPasteChunks = [];
			data = data.replace("\x1b[200~", "");
		}

		if (!this.customPasteInProgress) return false;

		this.customPasteChunks.push(data);
		const buffered = this.customPasteChunks.join("");
		const endIndex = buffered.indexOf("\x1b[201~");
		if (endIndex === -1) return true;

		const pastedText = buffered.slice(0, endIndex);
		const remaining = buffered.slice(endIndex + 6);
		this.customPasteChunks = [];
		this.customPasteInProgress = false;

		let handled = false;
		if (pastedText.length > 0) {
			try {
				handled = this.handleBracketedPaste(pastedText);
			} catch {
				handled = false;
			}

			if (!handled) {
				const textToPaste = this.shouldWrapPasteInMarkdownSeparators(pastedText)
					? this.textWithMarkdownSeparators(pastedText)
					: pastedText;
				if (this.hasSelection()) this.deleteSelection(false);
				this.clearSelection();
				this.i.handlePaste(textToPaste);
				this.tui.requestRender();
			}
		}

		if (remaining.length > 0) this.handleInput(remaining);
		return true;
	}

	private get i(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	private get state() {
		return this.i.state;
	}

	private currentPos(): Pos {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	private clonePos(pos: Pos): Pos {
		return { line: pos.line, col: pos.col };
	}

	private comparePos(a: Pos, b: Pos): number {
		if (a.line !== b.line) return a.line - b.line;
		return a.col - b.col;
	}

	private getCurrentRawText(): string {
		return this.state.lines.join("\n");
	}

	private snapshotState(): EditorStateSnapshot {
		return {
			lines: [...this.state.lines],
			cursorLine: this.state.cursorLine,
			cursorCol: this.state.cursorCol,
		};
	}

	private restoreState(snapshot: EditorStateSnapshot): void {
		this.i.cancelAutocomplete();
		this.i.jumpMode = null;
		this.state.lines = snapshot.lines.length === 0 ? [""] : [...snapshot.lines];
		this.state.cursorLine = Math.max(0, Math.min(snapshot.cursorLine, this.state.lines.length - 1));
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.i.setCursorCol(Math.max(0, Math.min(snapshot.cursorCol, currentLine.length)));
		this.i.scrollOffset = 0;
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private undoWithRedo(): void {
		const undoStack = (this as unknown as { undoStack?: { length: number } }).undoStack;
		if (!undoStack || undoStack.length === 0) return;
		this.redoStack.push(this.snapshotState());
		this.clearSelection();
		this.i.undo();
		this.tui.requestRender();
	}

	private redo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.basePushUndoSnapshot?.();
		this.restoreState(snapshot);
	}

	private setPromptBufferText(text: string): void {
		const lines = text.split("\n");
		this.i.cancelAutocomplete();
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = 0;
		this.i.setCursorCol(0);
		this.i.scrollOffset = 0;
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private tryNavigatePromptBuffer(direction: -1 | 1): boolean {
		const history = this.i.history;
		if (history.length === 0) return false;

		const targetIndex = this.promptBufferIndex + (direction < 0 ? 1 : -1);
		if (targetIndex < -1 || targetIndex >= history.length) return false;

		if (this.promptBufferIndex === -1 && targetIndex >= 0) {
			this.i.pushUndoSnapshot();
		}

		this.promptBufferTexts.set(this.promptBufferIndex, this.getCurrentRawText());
		this.promptBufferIndex = targetIndex;

		const nextText =
			targetIndex === -1
				? (this.promptBufferTexts.get(-1) ?? "")
				: (this.promptBufferTexts.get(targetIndex) ?? history[targetIndex] ?? "");
		this.setPromptBufferText(nextText);
		return true;
	}

	resetAfterSubmit(): void {
		this.promptBufferIndex = -1;
		this.promptBufferTexts.clear();
		this.redoStack.length = 0;
	}

	private normalizeRange(a: Pos, b: Pos): Range {
		return this.comparePos(a, b) <= 0 ? { start: this.clonePos(a), end: this.clonePos(b) } : { start: this.clonePos(b), end: this.clonePos(a) };
	}

	private getSelectionRange(): Range | null {
		if (!this.selectionAnchor) return null;
		const cursor = this.currentPos();
		if (this.comparePos(this.selectionAnchor, cursor) === 0) return null;
		return this.normalizeRange(this.selectionAnchor, cursor);
	}

	private hasSelection(): boolean {
		return this.getSelectionRange() !== null;
	}

	private clearSelection(): void {
		this.selectionAnchor = null;
	}

	private beginSelectionIfNeeded(): void {
		if (!this.selectionAnchor) this.selectionAnchor = this.currentPos();
	}

	private setCursor(pos: Pos): void {
		this.state.cursorLine = pos.line;
		this.i.setCursorCol(pos.col);
	}

	private moveToDocumentStart(): void {
		this.state.cursorLine = 0;
		this.i.setCursorCol(0);
	}

	private moveToDocumentEnd(): void {
		const lastLine = Math.max(0, this.state.lines.length - 1);
		this.state.cursorLine = lastLine;
		this.i.setCursorCol((this.state.lines[lastLine] || "").length);
	}

	private selectAll(): void {
		this.selectionAnchor = { line: 0, col: 0 };
		this.moveToDocumentEnd();
		if (!this.hasSelection()) this.clearSelection();
		this.tui.requestRender();
	}

	private getSelectedText(): string | null {
		const range = this.getSelectionRange();
		if (!range) return null;

		const lines = this.state.lines;
		if (range.start.line === range.end.line) {
			return (lines[range.start.line] || "").slice(range.start.col, range.end.col);
		}

		const parts: string[] = [];
		parts.push((lines[range.start.line] || "").slice(range.start.col));
		for (let line = range.start.line + 1; line < range.end.line; line++) {
			parts.push(lines[line] || "");
		}
		parts.push((lines[range.end.line] || "").slice(0, range.end.col));
		return parts.join("\n");
	}

	private copyTextToClipboard(text: string): void {
		void copyToClipboard(text).catch(() => {
			// Ignore clipboard failures; editor interactions should stay instant.
		});
	}

	private debugKeyInput(data: string): void {
		if (!ENABLE_KEY_DEBUG_LOG) return;
		try {
			const kittyPrintable = decodeKittyPrintable(data);
			const preview = data.length > KEY_DEBUG_PREVIEW_CHARS ? `${data.slice(0, KEY_DEBUG_PREVIEW_CHARS)}…` : data;
			const hex = Buffer.from(data, "utf8").toString("hex");
			const record = {
				t: Date.now(),
				length: data.length,
				preview: JSON.stringify(preview),
				chars: [...preview].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`),
				hexPreview: hex.length > KEY_DEBUG_PREVIEW_CHARS * 2 ? `${hex.slice(0, KEY_DEBUG_PREVIEW_CHARS * 2)}…` : hex,
				kittyPrintable,
				isKeyRelease: isKeyRelease(data),
				isRawEnye: data === "ñ" || data === "Ñ",
				matchesShiftEnd: matchesKey(data, "shift+end"),
				matchesEnd: matchesKey(data, "end"),
				matchesCtrlShiftEnd: matchesKey(data, "ctrl+shift+end"),
				matchesCtrlEnd: matchesKey(data, "ctrl+end"),
			};
			appendFileSync(KEY_DEBUG_LOG, `${JSON.stringify(record)}\n`, "utf8");
		} catch {
			// Debug logging should never affect input handling.
		}
	}

	private shouldDropAhkLeakedAltEnye(data: string): boolean {
		// The leaked key after AHK Alt+Shift+ñ is not raw "ñ"; the log shows
		// it as ESC + Ñ (`"\u001bÑ"`, hex `1b c3 91`). In terminals, ESC+char
		// is the legacy encoding for Alt+char. This is never useful text input
		// for the prompt, and if it falls through it clears the selection.
		return data === "\x1bñ" || data === "\x1bÑ";
	}

	private collapseSelection(to: "start" | "end"): boolean {
		const range = this.getSelectionRange();
		if (!range) return false;
		this.setCursor(to === "start" ? range.start : range.end);
		this.clearSelection();
		this.tui.requestRender();
		return true;
	}

	private moveWithoutSelection(direction: "backward" | "forward", mover: () => void): void {
		if (this.collapseSelection(direction === "backward" ? "start" : "end")) return;
		mover();
		this.clearSelection();
		this.tui.requestRender();
	}

	private moveWithSelection(mover: () => void): void {
		this.beginSelectionIfNeeded();
		mover();
		if (!this.hasSelection()) this.clearSelection();
		this.tui.requestRender();
	}

	private deleteRange(range: Range, pushUndo: boolean): void {
		this.i.cancelAutocomplete();
		this.i.jumpMode = null;
		if (pushUndo) this.i.pushUndoSnapshot();

		const lines = this.state.lines;
		if (range.start.line === range.end.line) {
			const line = lines[range.start.line] || "";
			lines[range.start.line] = line.slice(0, range.start.col) + line.slice(range.end.col);
		} else {
			const first = lines[range.start.line] || "";
			const last = lines[range.end.line] || "";
			const merged = first.slice(0, range.start.col) + last.slice(range.end.col);
			lines.splice(range.start.line, range.end.line - range.start.line + 1, merged);
		}

		this.state.cursorLine = range.start.line;
		this.i.setCursorCol(range.start.col);
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private deleteSelection(pushUndo: boolean = true): boolean {
		const range = this.getSelectionRange();
		if (!range) return false;
		this.deleteRange(range, pushUndo);
		return true;
	}

	private replaceSelectionWithText(text: string): void {
		const range = this.getSelectionRange();
		if (!range) {
			this.i.insertTextAtCursorInternal(text);
			this.tui.requestRender();
			return;
		}

		this.i.cancelAutocomplete();
		this.i.pushUndoSnapshot();
		this.deleteRange(range, false);
		this.i.insertTextAtCursorInternal(text);
		this.tui.requestRender();
	}

	private replaceSelectionWithChar(char: string): void {
		const range = this.getSelectionRange();
		if (!range) {
			this.i.insertCharacter(char);
			this.tui.requestRender();
			return;
		}

		this.i.cancelAutocomplete();
		this.i.pushUndoSnapshot();
		this.deleteRange(range, false);
		this.i.insertCharacter(char, true);
		this.tui.requestRender();
	}

	private cutCurrentLine(): void {
		const lineIndex = this.state.cursorLine;
		const lines = this.state.lines;
		const cutText = lines[lineIndex] ?? "";

		this.i.cancelAutocomplete();
		this.i.jumpMode = null;
		this.i.pushUndoSnapshot();

		if (lines.length <= 1) {
			lines[0] = "";
			this.state.cursorLine = 0;
			this.i.setCursorCol(0);
		} else {
			lines.splice(lineIndex, 1);
			this.state.cursorLine = Math.min(lineIndex, lines.length - 1);
			const currentLine = lines[this.state.cursorLine] ?? "";
			this.i.setCursorCol(Math.min(this.state.cursorCol, currentLine.length));
		}

		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
		this.copyTextToClipboard(cutText);
	}

	private duplicateCurrentLineBelow(): void {
		const lineIndex = this.state.cursorLine;
		const line = this.state.lines[lineIndex] ?? "";
		const targetCol = this.state.cursorCol;

		this.i.cancelAutocomplete();
		this.i.jumpMode = null;
		this.i.pushUndoSnapshot();
		this.state.lines.splice(lineIndex + 1, 0, line);
		this.state.cursorLine = lineIndex + 1;
		this.i.setCursorCol(Math.min(targetCol, line.length));
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private pieceWithSelection(text: string, pieceStartCol: number, lineNumber: number, range: Range | null): string {
		if (!range || text.length === 0) return text;
		if (lineNumber < range.start.line || lineNumber > range.end.line) return text;

		const pieceEndCol = pieceStartCol + text.length;
		let selStart = pieceStartCol;
		let selEnd = pieceEndCol;

		if (lineNumber === range.start.line) selStart = Math.max(selStart, range.start.col);
		if (lineNumber === range.end.line) selEnd = Math.min(selEnd, range.end.col);
		if (selStart >= selEnd) return text;

		const a = selStart - pieceStartCol;
		const b = selEnd - pieceStartCol;
		return text.slice(0, a) + REVERSE + text.slice(a, b) + RESET + text.slice(b);
	}

	private renderVisualLine(rawText: string, lineNumber: number, startCol: number, cursorPos: number | null, range: Range | null, emitCursorMarker: boolean): { text: string; width: number; cursorInPadding: boolean } {
		let lineVisibleWidth = visibleWidth(rawText);
		let cursorInPadding = false;

		const stylePiece = (piece: string, absoluteStartCol: number) =>
			this.pieceWithSelection(piece, absoluteStartCol, lineNumber, range);

		if (cursorPos === null) {
			return {
				text: stylePiece(rawText, startCol),
				width: lineVisibleWidth,
				cursorInPadding,
			};
		}

		const before = rawText.slice(0, cursorPos);
		const after = rawText.slice(cursorPos);
		const marker = emitCursorMarker ? CURSOR_MARKER : "";

		if (after.length > 0) {
			const firstGrapheme = [...this.i.segment(after)][0]?.segment || after[0] || "";
			const rest = after.slice(firstGrapheme.length);
			return {
				text:
					stylePiece(before, startCol) +
					marker +
					`${REVERSE}${firstGrapheme}${RESET}` +
					stylePiece(rest, startCol + cursorPos + firstGrapheme.length),
				width: lineVisibleWidth,
				cursorInPadding,
			};
		}

		lineVisibleWidth += 1;
		return {
			text: stylePiece(before, startCol) + marker + `${REVERSE} ${RESET}`,
			width: lineVisibleWidth,
			cursorInPadding: true,
		};
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		this.i.lastWidth = layoutWidth;

		const visualLines = this.i.buildVisualLineMap(layoutWidth);
		const currentVisualLine = this.i.findCurrentVisualLine(visualLines);
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		if (currentVisualLine < this.i.scrollOffset) {
			this.i.scrollOffset = currentVisualLine;
		} else if (currentVisualLine >= this.i.scrollOffset + maxVisibleLines) {
			this.i.scrollOffset = currentVisualLine - maxVisibleLines + 1;
		}

		const maxScrollOffset = Math.max(0, visualLines.length - maxVisibleLines);
		this.i.scrollOffset = Math.max(0, Math.min(this.i.scrollOffset, maxScrollOffset));

		const visibleVisualLines = visualLines.slice(this.i.scrollOffset, this.i.scrollOffset + maxVisibleLines);
		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		const horizontal = this.borderColor("─");
		const selectionRange = this.getSelectionRange();
		const emitCursorMarker = this.focused && !this.isShowingAutocomplete();

		if (this.i.scrollOffset > 0) {
			const indicator = `─── ↑ ${this.i.scrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(remaining >= 0 ? indicator + "─".repeat(remaining) : truncateToWidth(indicator, width)));
		} else {
			result.push(horizontal.repeat(width));
		}

		for (let visibleIndex = 0; visibleIndex < visibleVisualLines.length; visibleIndex++) {
			const visualIndex = this.i.scrollOffset + visibleIndex;
			const vl = visibleVisualLines[visibleIndex]!;
			const line = this.state.lines[vl.logicalLine] || "";
			const rawText = vl.length === 0 ? "" : line.slice(vl.startCol, vl.startCol + vl.length);
			const hasCursor = visualIndex === currentVisualLine;
			const cursorPos = hasCursor ? Math.max(0, Math.min(rawText.length, this.state.cursorCol - vl.startCol)) : null;

			const rendered = this.renderVisualLine(rawText, vl.logicalLine, vl.startCol, cursorPos, selectionRange, emitCursorMarker);
			const padding = " ".repeat(Math.max(0, contentWidth - rendered.width));
			const cursorOverflowsIntoPadding = rendered.cursorInPadding && rendered.width > contentWidth;
			const lineRightPadding = cursorOverflowsIntoPadding && paddingX > 0 ? rightPadding.slice(1) : rightPadding;
			result.push(`${leftPadding}${rendered.text}${padding}${lineRightPadding}`);
		}

		const linesBelow = visualLines.length - (this.i.scrollOffset + visibleVisualLines.length);
		if (linesBelow > 0) {
			const indicator = `─── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			const historyIndicator = this.promptBufferIndex > -1 ? ` history[${this.promptBufferIndex}] ` : "";
			if (historyIndicator) {
				const indicatorWidth = visibleWidth(historyIndicator);
				const leftWidth = Math.max(0, width - indicatorWidth - 2);
				const rightWidth = Math.max(0, width - leftWidth - indicatorWidth);
				result.push(
					this.borderColor("─".repeat(leftWidth)) +
					this.borderColor(historyIndicator) +
					this.borderColor("─".repeat(rightWidth)),
				);
			} else {
				result.push(horizontal.repeat(width));
			}
		}

		if (this.i.autocompleteState && this.i.autocompleteList) {
			const autocompleteResult = this.i.autocompleteList.render(contentWidth);
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleInput(data: string): void {
		this.debugKeyInput(data);
		if (isKeyRelease(data)) return;
		if (this.handleCustomPasteInput(data)) return;
		if (this.shouldDropAhkLeakedAltEnye(data)) return;

		// 0) Undo/redo. Handle these before `super.handleInput()` so Ctrl+Z
		// wins over pi's app.suspend binding on Unix-like terminals, and Ctrl+Y
		// overrides the base editor's yank binding.
		if (matchesKey(data, "ctrl+y") || matchesKey(data, "ctrl+shift+z")) {
			this.redo();
			return;
		}
		if (matchesKey(data, "ctrl+z") || matchesKey(data, "ctrl+-")) {
			this.undoWithRedo();
			return;
		}

		// 1) Clipboard/select-all behavior for active selections.
		if (!this.isShowingAutocomplete()) {
			if (matchesKey(data, "ctrl+a")) {
				this.selectAll();
				return;
			}

			if (matchesKey(data, "ctrl+d")) {
				this.duplicateCurrentLineBelow();
				return;
			}

			if (matchesKey(data, "ctrl+c") && this.hasSelection()) {
				const selectedText = this.getSelectedText();
				if (selectedText != null) {
					this.clearSelection();
					this.tui.requestRender();
					this.copyTextToClipboard(selectedText);
				}
				return;
			}

			if (matchesKey(data, "ctrl+x")) {
				if (this.hasSelection()) {
					const selectedText = this.getSelectedText();
					this.deleteSelection(true);
					if (selectedText != null) this.copyTextToClipboard(selectedText);
				} else {
					this.cutCurrentLine();
				}
				return;
			}
		}

		// 2) Escape clears selection first.
		if (matchesKey(data, "escape") && this.hasSelection()) {
			this.clearSelection();
			this.tui.requestRender();
			return;
		}

		// 3) Selection-aware movement.
		//    When selection exists, plain motion collapses it.
		if (!this.isShowingAutocomplete()) {
			if (matchesKey(data, "shift+left")) return this.moveWithSelection(() => this.i.moveCursor(0, -1));
			if (matchesKey(data, "shift+right")) return this.moveWithSelection(() => this.i.moveCursor(0, 1));
			if (matchesKey(data, "shift+up")) return this.moveWithSelection(() => this.i.moveCursor(-1, 0));
			if (matchesKey(data, "shift+down")) return this.moveWithSelection(() => this.i.moveCursor(1, 0));
			if (matchesKey(data, "shift+home")) return this.moveWithSelection(() => this.i.moveToLineStart());
			if (matchesKey(data, "shift+end")) return this.moveWithSelection(() => this.i.moveToLineEnd());
			if (matchesKey(data, "shift+pageUp")) return this.moveWithSelection(() => this.i.pageScroll(-1));
			if (matchesKey(data, "shift+pageDown")) return this.moveWithSelection(() => this.i.pageScroll(1));
			if (matchesKey(data, "ctrl+shift+left") || matchesKey(data, "alt+shift+left")) {
				return this.moveWithSelection(() => this.i.moveWordBackwards());
			}
			if (matchesKey(data, "ctrl+shift+right") || matchesKey(data, "alt+shift+right")) {
				return this.moveWithSelection(() => this.i.moveWordForwards());
			}
			if (matchesKey(data, "ctrl+shift+home")) return this.moveWithSelection(() => this.moveToDocumentStart());
			if (matchesKey(data, "ctrl+shift+end")) return this.moveWithSelection(() => this.moveToDocumentEnd());

			if (matchesKey(data, "left")) return this.moveWithoutSelection("backward", () => this.i.moveCursor(0, -1));
			if (matchesKey(data, "right")) return this.moveWithoutSelection("forward", () => this.i.moveCursor(0, 1));
			if (matchesKey(data, "up")) {
				if (this.hasSelection()) return this.moveWithoutSelection("backward", () => this.i.moveCursor(-1, 0));
				const visualLines = this.i.buildVisualLineMap(this.i.lastWidth);
				const currentVisualLine = this.i.findCurrentVisualLine(visualLines);
				if (this.getText().length === 0 || currentVisualLine === 0) {
					if (this.tryNavigatePromptBuffer(-1)) return;
					if (currentVisualLine === 0) return this.moveWithoutSelection("backward", () => this.i.moveToLineStart());
				}
				return this.moveWithoutSelection("backward", () => this.i.moveCursor(-1, 0));
			}
			if (matchesKey(data, "down")) {
				if (this.hasSelection()) return this.moveWithoutSelection("forward", () => this.i.moveCursor(1, 0));
				const visualLines = this.i.buildVisualLineMap(this.i.lastWidth);
				const currentVisualLine = this.i.findCurrentVisualLine(visualLines);
				const isLastVisualLine = currentVisualLine === visualLines.length - 1;
				if (isLastVisualLine && this.promptBufferIndex > -1 && this.tryNavigatePromptBuffer(1)) return;
				if (isLastVisualLine) return this.moveWithoutSelection("forward", () => this.i.moveToLineEnd());
				return this.moveWithoutSelection("forward", () => this.i.moveCursor(1, 0));
			}
			if (matchesKey(data, "home")) return this.moveWithoutSelection("backward", () => this.i.moveToLineStart());
			if (matchesKey(data, "end")) return this.moveWithoutSelection("forward", () => this.i.moveToLineEnd());
			if (matchesKey(data, "pageUp")) return this.moveWithoutSelection("backward", () => this.i.pageScroll(-1));
			if (matchesKey(data, "pageDown")) return this.moveWithoutSelection("forward", () => this.i.pageScroll(1));
			if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left")) {
				return this.moveWithoutSelection("backward", () => this.i.moveWordBackwards());
			}
			if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right")) {
				return this.moveWithoutSelection("forward", () => this.i.moveWordForwards());
			}
			if (matchesKey(data, "ctrl+home")) return this.moveWithoutSelection("backward", () => this.moveToDocumentStart());
			if (matchesKey(data, "ctrl+end")) return this.moveWithoutSelection("forward", () => this.moveToDocumentEnd());
		}

		// 4) Deletion becomes "delete selection" when a selection exists.
		if (this.hasSelection()) {
			if (
				matchesKey(data, "backspace") ||
				matchesKey(data, "shift+backspace") ||
				matchesKey(data, "delete") ||
				matchesKey(data, "shift+delete") ||
				matchesKey(data, "ctrl+w") ||
				matchesKey(data, "alt+backspace") ||
				matchesKey(data, "alt+d") ||
				matchesKey(data, "alt+delete") ||
				matchesKey(data, "ctrl+u") ||
				matchesKey(data, "ctrl+k")
			) {
				this.deleteSelection(true);
				return;
			}
		}

		// 5) Typing replaces selection.
		if (this.hasSelection()) {
			if (matchesKey(data, "shift+space")) {
				this.replaceSelectionWithChar(" ");
				return;
			}

			const kittyPrintable = decodeKittyPrintable(data);
			if (kittyPrintable !== undefined) {
				this.replaceSelectionWithChar(kittyPrintable);
				return;
			}

			if (data.length > 0 && data.charCodeAt(0) >= 32) {
				this.replaceSelectionWithChar(data);
				return;
			}

			// Common newline inputs for replacement semantics.
			if (
				matchesKey(data, "shift+enter") ||
				(data.charCodeAt(0) === 10 && data.length > 1) ||
				data === "\x1b\r" ||
				data === "\x1b[13;2~" ||
				(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
				data === "\n"
			) {
				this.replaceSelectionWithText("\n");
				return;
			}

			// For bracketed paste, collapse selection by deleting it first, then
			// pass through to the base editor's paste machinery.
			if (data.includes("\x1b[200~")) {
				this.deleteSelection(true);
				super.handleInput(data);
				return;
			}
		}

		// Default behavior.
		this.clearSelection();
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	let activeEditor: SelectionEditor | null = null;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			activeEditor = new SelectionEditor(tui, theme, kb);
			return activeEditor;
		});
		ctx.ui.notify("Selection editor loaded", "info");
	});

	pi.on("before_agent_start", () => {
		activeEditor?.resetAfterSubmit();
	});
}
