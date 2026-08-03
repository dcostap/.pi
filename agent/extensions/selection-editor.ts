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
 * - Paste the same collapsed paste twice within two seconds to force it inline
 * - Chrome-style inline completion from one-line prompt templates
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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { copyToClipboard, CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Pos = { line: number; col: number };
type Range = { start: Pos; end: Pos };
type VisualLine = { logicalLine: number; startCol: number; length: number };
type PasteStateSnapshot = { pastes: Map<number, string>; pasteCounter: number };
type EditorStateSnapshot = { lines: string[]; cursorLine: number; cursorCol: number } & PasteStateSnapshot;
type PromptBufferState = { text: string } & PasteStateSnapshot;
type PendingInlinePaste = {
	sourceText: string;
	content: string;
	createdAt: number;
	markerId: number;
	markerText: string;
	markerRange: Range;
	cursorAfter: Pos;
	rawTextAfter: string;
};
type InlinePromptCandidate = {
	text: string;
	firstWord: string;
};
type InlinePromptCompletion = {
	line: number;
	startCol: number;
	counterStartCol: number;
	endCol: number;
	typedText: string;
	candidates: InlinePromptCandidate[];
	selectedIndex: number;
	appendedText: string;
};
type InlinePromptContinuation = {
	line: number;
	startCol: number;
	selectedText?: string;
};

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
	tryTriggerAutocomplete(explicitTab?: boolean): void;
	handlePaste(pastedText: string): void;
	undo(): void;
	history: string[];
	jumpMode: "forward" | "backward" | null;
	pastes: Map<number, string>;
	pasteCounter: number;
};

const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";
const LARGE_PASTE_FILE_THRESHOLD = 5_000;
const PASTE_MARKER_LINE_THRESHOLD = 10;
const PASTE_MARKER_CHAR_THRESHOLD = 1_000;
const DOUBLE_PASTE_INLINE_WINDOW_MS = 2_000;
const LARGE_PASTE_DIR = join(tmpdir(), "pi-paste-dumps");
const KEY_DEBUG_LOG = join(tmpdir(), "pi-selection-editor-keys.log");
const ENABLE_KEY_DEBUG_LOG = process.env.PI_SELECTION_EDITOR_KEY_DEBUG === "1";
const KEY_DEBUG_PREVIEW_CHARS = 160;
const PASTE_MARKER_REGEX = /\[paste #(\d+)( \+\d+ lines| \d+ chars)?\]/g;
const PROMPT_PLACEHOLDER_REGEX = /\{\{[^{}\r\n]+\}\}/g;

function parsePromptContent(filePath: string): string | null {
	try {
		const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
		const lines = raw.split(/\r?\n/);
		if (lines[0]?.trim() !== "---") return raw.trim();

		const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		return (frontmatterEnd === -1 ? raw : lines.slice(frontmatterEnd + 1).join("\n")).trim();
	} catch {
		return null;
	}
}

function loadInlinePromptCandidates(pi: ExtensionAPI): InlinePromptCandidate[] {
	const candidates: InlinePromptCandidate[] = [];
	const seenText = new Set<string>();

	for (const command of pi.getCommands()) {
		if (command.source !== "prompt") continue;
		const text = parsePromptContent(command.sourceInfo.path);
		if (!text || /[\r\n]/.test(text) || seenText.has(text)) continue;
		const firstToken = text.match(/^\S+/)?.[0];
		const firstWord = firstToken?.replace(/[.,!?;:)\]}]+$/u, "");
		if (!firstWord) continue;

		seenText.add(text);
		candidates.push({ text, firstWord });
	}

	return candidates;
}

class SelectionEditor extends CustomEditor {
	private selectionAnchor: Pos | null = null;
	private inlinePromptCompletion: InlinePromptCompletion | null = null;
	private inlinePromptContinuation: InlinePromptContinuation | null = null;
	private readonly inlinePromptCounterColor: (text: string) => string;
	private customPasteChunks: string[] = [];
	private customPasteInProgress = false;
	private pendingInlinePaste: PendingInlinePaste | null = null;
	private promptBufferIndex = -1;
	private promptBufferStates = new Map<number, PromptBufferState>();
	private markerUndoStack: PasteStateSnapshot[] = [];
	private redoStack: EditorStateSnapshot[] = [];
	private basePushUndoSnapshot: (() => void) | null = null;
	private baseUndo: (() => void) | null = null;

	constructor(
		private readonly inlinePromptCandidates: InlinePromptCandidate[],
		...args: ConstructorParameters<typeof CustomEditor>
	) {
		super(...args);
		const promptTheme = args[1] as unknown as {
			fg?: (color: "accent", text: string) => string;
			italic?: (text: string) => string;
		};
		this.inlinePromptCounterColor = (text: string) => {
			const emphasized = promptTheme.italic?.(text) ?? text;
			return promptTheme.fg?.("accent", emphasized) ?? emphasized;
		};

		// The base Editor already owns undo snapshots. Patch the runtime TS-private
		// method so every normal edit invalidates redo, while redo itself can still
		// push an undo snapshot through `basePushUndoSnapshot` without clearing the
		// remaining redo chain.
		this.basePushUndoSnapshot = this.i.pushUndoSnapshot.bind(this);
		this.baseUndo = this.i.undo.bind(this);
		this.i.pushUndoSnapshot = () => {
			this.redoStack.length = 0;
			this.markerUndoStack.push(this.snapshotPasteState());
			this.basePushUndoSnapshot?.();
		};
		this.i.undo = () => {
			const undoStack = (this as unknown as { undoStack?: { length: number } }).undoStack;
			if (!undoStack || undoStack.length === 0) return;

			this.redoStack.push(this.snapshotState());
			const pasteSnapshot = this.markerUndoStack.pop();
			this.baseUndo?.();
			if (pasteSnapshot) this.restorePasteState(pasteSnapshot);
		};
	}

	setText(text: string): void {
		this.cancelInlinePromptCompletion();
		this.inlinePromptContinuation = null;
		this.pendingInlinePaste = null;
		const previousText = this.getText();
		const previousPasteState = this.snapshotPasteState();
		const undoDepth = this.markerUndoStack.length;

		super.setText(text);

		if (this.getText() === previousText) {
			// The base editor clears paste metadata before checking whether the text
			// changed. Preserve it when setText is effectively a no-op.
			this.restorePasteState(previousPasteState);
		} else if (this.markerUndoStack.length > undoDepth) {
			// The base snapshot is pushed after it clears paste metadata. Pair that
			// text snapshot with the metadata from the actual pre-setText state.
			this.markerUndoStack[this.markerUndoStack.length - 1] = previousPasteState;
		}
	}

	/**
	 * Pi transfers only getText() when installing a custom editor. If input was
	 * pasted into the default editor during startup, that text can therefore
	 * arrive here as a marker while ctx.ui.getEditorText() still has the expanded
	 * value. Reattach the hidden content without changing the visible prompt.
	 */
	restoreTransferredText(expandedText: string): void {
		this.pendingInlinePaste = null;
		const rawText = this.getText();
		if (rawText === expandedText) return;

		const markers = [...rawText.matchAll(/\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g)];
		if (markers.length === 1) {
			const marker = markers[0]!;
			const markerOffset = marker.index ?? 0;
			const prefix = rawText.slice(0, markerOffset);
			const suffix = rawText.slice(markerOffset + marker[0].length);
			const contentEnd = expandedText.length - suffix.length;

			if (
				expandedText.startsWith(prefix) &&
				expandedText.endsWith(suffix) &&
				contentEnd >= prefix.length
			) {
				const pasteId = Number(marker[1]);
				const pasteContent = expandedText.slice(prefix.length, contentEnd);

				// Input is accepted while session_start handlers are still running. A
				// very large paste can therefore be collapsed by Pi's default editor
				// before this custom editor (and its file-dump policy) is installed.
				// Apply that policy now instead of reattaching a huge hidden marker.
				if (this.shouldDumpPasteToFile(pasteContent)) {
					try {
						const filePath = this.writeLargePasteFile(pasteContent);
						const fileReference = this.formatFileReference(filePath, prefix[prefix.length - 1] ?? "");
						super.setText(prefix + fileReference + suffix);
						const undoStack = (this as unknown as { undoStack?: { clear(): void } }).undoStack;
						undoStack?.clear();
						this.markerUndoStack.length = 0;
						this.redoStack.length = 0;
						this.tui.requestRender();
						return;
					} catch {
						// Fall back to preserving the paste marker and its hidden content.
					}
				}

				this.i.pastes.set(pasteId, pasteContent);
				this.i.pasteCounter = Math.max(this.i.pasteCounter, pasteId);
				this.tui.requestRender();
				return;
			}
		}

		// Multiple markers cannot be separated unambiguously from expanded text.
		// Preserve the exact content as one paste instead of risking silent loss.
		super.setText("");
		const undoStack = (this as unknown as { undoStack?: { clear(): void } }).undoStack;
		undoStack?.clear();
		this.markerUndoStack.length = 0;
		this.redoStack.length = 0;
		this.i.handlePaste(expandedText);
		this.tui.requestRender();
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

	private writeLargePasteFile(pastedText: string): string {
		const fileContent = this.normalizePastedFileContent(pastedText);
		const filePath = this.makeLargePasteFilePath();
		writeFileSync(filePath, fileContent, "utf8");
		return filePath;
	}

	private formatFileReference(filePath: string, charBefore: string): string {
		const normalizedPath = filePath.replace(/\\/g, "/");
		const fileReference = `@${normalizedPath}`;
		return charBefore && !/\s/.test(charBefore) ? ` ${fileReference}` : fileReference;
	}

	private insertFilePathAtCursor(filePath: string, pushUndo: boolean): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
		const textToInsert = this.formatFileReference(filePath, charBeforeCursor);

		this.i.cancelAutocomplete();
		if (pushUndo) this.i.pushUndoSnapshot();
		this.i.insertTextAtCursorInternal(textToInsert);
		this.tui.requestRender();
	}

	private handleBracketedPaste(pastedText: string): boolean {
		if (!this.shouldDumpPasteToFile(pastedText)) return false;

		const filePath = this.writeLargePasteFile(pastedText);

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

	private rememberCollapsedPaste(sourceText: string, start: Pos, previousPasteCounter: number): void {
		this.pendingInlinePaste = null;

		const markerId = this.i.pasteCounter;
		if (markerId <= previousPasteCounter) return;
		const content = this.i.pastes.get(markerId);
		if (content === undefined) return;

		const cursorAfter = this.currentPos();
		if (cursorAfter.line !== start.line || cursorAfter.col <= start.col) return;

		const markerText = (this.state.lines[start.line] ?? "").slice(start.col, cursorAfter.col);
		const markerMatch = markerText.match(/^\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]$/);
		if (!markerMatch || Number(markerMatch[1]) !== markerId) return;

		this.pendingInlinePaste = {
			sourceText,
			content,
			createdAt: Date.now(),
			markerId,
			markerText,
			markerRange: { start: this.clonePos(start), end: this.clonePos(cursorAfter) },
			cursorAfter: this.clonePos(cursorAfter),
			rawTextAfter: this.getCurrentRawText(),
		};
	}

	private tryInlineRepeatedPaste(sourceText: string): boolean {
		const pending = this.pendingInlinePaste;
		this.pendingInlinePaste = null;
		if (!pending) return false;

		const cursor = this.currentPos();
		const markerLine = this.state.lines[pending.markerRange.start.line] ?? "";
		const markerStillPresent =
			pending.markerRange.start.line === pending.markerRange.end.line &&
			markerLine.slice(pending.markerRange.start.col, pending.markerRange.end.col) === pending.markerText;
		const storedContent = this.i.pastes.get(pending.markerId);

		if (
			Date.now() - pending.createdAt > DOUBLE_PASTE_INLINE_WINDOW_MS ||
			sourceText !== pending.sourceText ||
			this.hasSelection() ||
			this.comparePos(cursor, pending.cursorAfter) !== 0 ||
			this.getCurrentRawText() !== pending.rawTextAfter ||
			!markerStillPresent ||
			storedContent !== pending.content
		) {
			return false;
		}

		// Do not push another undo snapshot: the snapshot created by the first
		// paste should undo the entire double-paste action, not reveal the marker.
		this.deleteRange(pending.markerRange, false);
		this.i.insertTextAtCursorInternal(pending.content);
		this.tui.requestRender();
		return true;
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

		if (this.tryInlineRepeatedPaste(pastedText)) {
			if (remaining.length > 0) this.handleInput(remaining);
			return true;
		}

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
				const pasteStart = this.currentPos();
				const previousPasteCounter = this.i.pasteCounter;
				this.i.handlePaste(textToPaste);
				this.rememberCollapsedPaste(pastedText, pasteStart, previousPasteCounter);
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

	private snapshotPasteState(): PasteStateSnapshot {
		return {
			pastes: new Map(this.i.pastes),
			pasteCounter: this.i.pasteCounter,
		};
	}

	private restorePasteState(snapshot: PasteStateSnapshot): void {
		this.i.pastes = new Map(snapshot.pastes);
		this.i.pasteCounter = snapshot.pasteCounter;
	}

	private snapshotState(): EditorStateSnapshot {
		return {
			lines: [...this.state.lines],
			cursorLine: this.state.cursorLine,
			cursorCol: this.state.cursorCol,
			...this.snapshotPasteState(),
		};
	}

	private restoreState(snapshot: EditorStateSnapshot): void {
		this.i.cancelAutocomplete();
		this.i.jumpMode = null;
		this.state.lines = snapshot.lines.length === 0 ? [""] : [...snapshot.lines];
		this.state.cursorLine = Math.max(0, Math.min(snapshot.cursorLine, this.state.lines.length - 1));
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.i.setCursorCol(Math.max(0, Math.min(snapshot.cursorCol, currentLine.length)));
		this.restorePasteState(snapshot);
		this.i.scrollOffset = 0;
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private undoWithRedo(): void {
		this.clearSelection();
		this.i.undo();
		this.tui.requestRender();
	}

	private redo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.markerUndoStack.push(this.snapshotPasteState());
		this.basePushUndoSnapshot?.();
		this.restoreState(snapshot);
	}

	private snapshotPromptBufferState(): PromptBufferState {
		return { text: this.getCurrentRawText(), ...this.snapshotPasteState() };
	}

	private setPromptBufferState(buffer: PromptBufferState): void {
		const lines = buffer.text.split("\n");
		this.i.cancelAutocomplete();
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = 0;
		this.i.setCursorCol(0);
		this.restorePasteState(buffer);
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

		this.promptBufferStates.set(this.promptBufferIndex, this.snapshotPromptBufferState());
		this.promptBufferIndex = targetIndex;

		const savedBuffer = this.promptBufferStates.get(targetIndex);
		const nextBuffer = savedBuffer ?? {
			text: targetIndex === -1 ? "" : (history[targetIndex] ?? ""),
			pastes: new Map<number, string>(),
			pasteCounter: 0,
		};
		this.setPromptBufferState(nextBuffer);
		return true;
	}

	resetAfterSubmit(): void {
		this.inlinePromptCompletion = null;
		this.inlinePromptContinuation = null;
		this.clearSelection();
		this.pendingInlinePaste = null;
		this.promptBufferIndex = -1;
		this.promptBufferStates.clear();
		this.markerUndoStack.length = 0;
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

	private inlinePromptMatches(typedText: string): InlinePromptCandidate[] {
		if (!typedText || /[\r\n]/.test(typedText)) return [];
		const foldedTyped = typedText.toLocaleLowerCase();

		return this.inlinePromptCandidates.filter((candidate) => {
			const minimumPrefixLength = Math.min(4, candidate.firstWord.length);
			return (
				typedText.length >= minimumPrefixLength &&
				candidate.text.length > typedText.length &&
				candidate.text.toLocaleLowerCase().startsWith(foldedTyped)
			);
		});
	}

	private findInlinePromptContext(
		currentLine: string,
		cursorCol: number,
	): { startCol: number; typedText: string; candidates: InlinePromptCandidate[] } | null {
		const beforeCursor = currentLine.slice(0, cursorCol);
		const possibleStarts = [0];
		for (let index = 1; index < beforeCursor.length; index++) {
			if (/\s/u.test(beforeCursor[index - 1] ?? "") && !/\s/u.test(beforeCursor[index] ?? "")) {
				possibleStarts.push(index);
			}
		}

		let best: { startCol: number; typedText: string; candidates: InlinePromptCandidate[] } | null = null;
		for (const startCol of possibleStarts) {
			const typedText = beforeCursor.slice(startCol);
			const candidates = this.inlinePromptMatches(typedText);
			if (candidates.length === 0 || (best && best.typedText.length >= typedText.length)) continue;
			best = { startCol, typedText, candidates };
		}
		return best;
	}

	private installInlinePromptCompletion(
		line: number,
		startCol: number,
		typedText: string,
		candidates: InlinePromptCandidate[],
		selectedText?: string,
	): boolean {
		if (candidates.length === 0 || this.isShowingAutocomplete() || this.hasSelection()) return false;
		const currentLine = this.state.lines[line] ?? "";
		const cursor = this.currentPos();
		if (
			cursor.line !== line ||
			cursor.col !== startCol + typedText.length ||
			currentLine.slice(startCol, cursor.col) !== typedText ||
			currentLine.slice(cursor.col).trim() !== ""
		) {
			return false;
		}

		let selectedIndex = selectedText
			? candidates.findIndex((candidate) => candidate.text === selectedText)
			: 0;
		if (selectedIndex < 0) selectedIndex = 0;
		const selected = candidates[selectedIndex]!;
		const suffix = selected.text.slice(typedText.length);
		const counter = ` (${selectedIndex + 1}/${candidates.length})`;
		const appendedText = suffix + counter;

		this.i.cancelAutocomplete();
		this.state.lines[line] = currentLine.slice(0, cursor.col) + appendedText + currentLine.slice(cursor.col);
		this.inlinePromptCompletion = {
			line,
			startCol,
			counterStartCol: cursor.col + suffix.length,
			endCol: cursor.col + appendedText.length,
			typedText,
			candidates,
			selectedIndex,
			appendedText,
		};
		this.inlinePromptContinuation = null;
		// Use a backwards selection so the visible caret remains exactly where
		// the user was typing while the generated suffix is highlighted.
		this.selectionAnchor = { line, col: cursor.col + suffix.length };
		this.setCursor({ line, col: cursor.col });
		this.tui.requestRender();
		return true;
	}

	private maybeActivateInlinePromptCompletion(continuation?: InlinePromptContinuation): void {
		if (this.inlinePromptCompletion || this.isShowingAutocomplete() || this.hasSelection()) return;
		const cursor = this.currentPos();
		const currentLine = this.state.lines[cursor.line] ?? "";
		if (currentLine.slice(cursor.col).trim() !== "") {
			this.inlinePromptContinuation = null;
			return;
		}

		const preferred = continuation ?? this.inlinePromptContinuation;
		if (preferred && preferred.line === cursor.line && cursor.col >= preferred.startCol) {
			const typedText = currentLine.slice(preferred.startCol, cursor.col);
			const candidates = this.inlinePromptMatches(typedText);
			if (
				this.installInlinePromptCompletion(
					cursor.line,
					preferred.startCol,
					typedText,
					candidates,
					preferred.selectedText,
				)
			) {
				return;
			}

			// Keep the original word start while the user corrects a mismatch. This
			// lets deleting the bad character restore a completion even after the
			// manually typed prefix has advanced into later words of the candidate.
			this.inlinePromptContinuation = preferred;
		} else if (preferred) {
			this.inlinePromptContinuation = null;
		}

		const fresh = this.findInlinePromptContext(currentLine, cursor.col);
		if (!fresh) return;
		this.installInlinePromptCompletion(
			cursor.line,
			fresh.startCol,
			fresh.typedText,
			fresh.candidates,
		);
	}

	private detachInlinePromptCompletion(requestRender: boolean = true): InlinePromptContinuation | null {
		const completion = this.inlinePromptCompletion;
		if (!completion) return null;
		this.inlinePromptCompletion = null;

		const line = this.state.lines[completion.line] ?? "";
		if (line.slice(completion.endCol - completion.appendedText.length, completion.endCol) === completion.appendedText) {
			const suggestionStart = completion.endCol - completion.appendedText.length;
			this.state.lines[completion.line] = line.slice(0, suggestionStart) + line.slice(completion.endCol);
			this.setCursor({ line: completion.line, col: suggestionStart });
		}

		this.clearSelection();
		if (requestRender) this.tui.requestRender();
		return {
			line: completion.line,
			startCol: completion.startCol,
			selectedText: completion.candidates[completion.selectedIndex]?.text,
		};
	}

	private cancelInlinePromptCompletion(): boolean {
		this.inlinePromptContinuation = null;
		if (!this.inlinePromptCompletion) return false;
		this.detachInlinePromptCompletion();
		return true;
	}

	private cycleInlinePromptCompletion(): void {
		const completion = this.inlinePromptCompletion;
		if (!completion) return;
		const nextIndex = (completion.selectedIndex + 1) % completion.candidates.length;
		const selectedText = completion.candidates[nextIndex]?.text;
		const continuation = this.detachInlinePromptCompletion(false);
		if (!continuation) return;
		this.installInlinePromptCompletion(
			completion.line,
			completion.startCol,
			completion.typedText,
			completion.candidates,
			selectedText,
		);
	}

	private acceptInlinePromptCompletion(promoteSelection: boolean = false): boolean {
		const completion = this.inlinePromptCompletion;
		if (!completion) return false;
		const selected = completion.candidates[completion.selectedIndex];
		this.detachInlinePromptCompletion(false);
		if (!selected) return false;

		const suffix = selected.text.slice(completion.typedText.length);
		this.i.pushUndoSnapshot();
		this.i.insertTextAtCursorInternal(suffix);
		if (promoteSelection) {
			// Turn the generated suffix into an ordinary backwards selection. The
			// existing selection editor can then extend, shrink, copy, replace, or
			// delete it without needing autocomplete-specific versions of those keys.
			this.selectionAnchor = { line: completion.line, col: completion.startCol + selected.text.length };
			this.setCursor({ line: completion.line, col: completion.startCol + completion.typedText.length });
		} else {
			this.clearSelection();
		}
		this.tui.requestRender();
		return true;
	}

	private isSelectionAddingInput(data: string): boolean {
		return (
			matchesKey(data, "ctrl+a") ||
			matchesKey(data, "shift+left") ||
			matchesKey(data, "shift+right") ||
			matchesKey(data, "shift+up") ||
			matchesKey(data, "shift+down") ||
			matchesKey(data, "shift+home") ||
			matchesKey(data, "shift+end") ||
			matchesKey(data, "shift+pageUp") ||
			matchesKey(data, "shift+pageDown") ||
			matchesKey(data, "ctrl+shift+left") ||
			matchesKey(data, "alt+shift+left") ||
			matchesKey(data, "ctrl+shift+right") ||
			matchesKey(data, "alt+shift+right") ||
			matchesKey(data, "ctrl+shift+home") ||
			matchesKey(data, "ctrl+shift+end")
		);
	}

	private getInlinePromptInputKind(data: string): "deletion" | "printable" | null {
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
			return "deletion";
		}

		const kittyPrintable = decodeKittyPrintable(data);
		if (
			matchesKey(data, "shift+space") ||
			kittyPrintable !== undefined ||
			(data.length > 0 && data.charCodeAt(0) >= 32)
		) {
			return "printable";
		}

		return null;
	}

	private handleInlinePromptCompletionInput(data: string): boolean {
		if (!this.inlinePromptCompletion) return false;

		if (this.isSelectionAddingInput(data)) {
			this.acceptInlinePromptCompletion(true);
			return false;
		}
		if (matchesKey(data, "tab")) {
			this.cycleInlinePromptCompletion();
			return true;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "ctrl+right") ||
			matchesKey(data, "ctrl+f") ||
			matchesKey(data, "end")
		) {
			this.acceptInlinePromptCompletion();
			return true;
		}
		if (matchesKey(data, "enter")) {
			// Enter submits only what the user actually typed. The inline candidate is
			// still a preview at this point, so discard it rather than accepting it.
			this.cancelInlinePromptCompletion();
			super.handleInput(data);
			return true;
		}
		if (matchesKey(data, "escape")) {
			this.cancelInlinePromptCompletion();
			return true;
		}

		const inputKind = this.getInlinePromptInputKind(data);
		if (inputKind === "deletion") {
			// The generated suffix is the active selection. Backspace/delete removes
			// that transient selection only; a second press edits the user's text.
			this.cancelInlinePromptCompletion();
			return true;
		}
		const continuation = this.detachInlinePromptCompletion(false);

		if (inputKind !== "printable") {
			this.inlinePromptContinuation = null;
			return false;
		}

		const textBeforeInput = this.getText();
		super.handleInput(data);
		if (this.getText() !== textBeforeInput) {
			this.pruneUnusedPasteMarkers();
			this.maybeTriggerInlineSlashAutocomplete();
			if (!this.isShowingAutocomplete() && continuation) {
				this.maybeActivateInlinePromptCompletion(continuation);
			}
		}
		return true;
	}

	private positionToOffset(pos: Pos): number {
		let offset = 0;
		for (let line = 0; line < pos.line; line++) {
			offset += (this.state.lines[line] ?? "").length + 1;
		}
		return offset + pos.col;
	}

	private offsetToPosition(offset: number): Pos {
		let remaining = Math.max(0, offset);
		for (let line = 0; line < this.state.lines.length; line++) {
			const length = (this.state.lines[line] ?? "").length;
			if (remaining <= length) return { line, col: remaining };
			remaining -= length + 1;
		}

		const line = Math.max(0, this.state.lines.length - 1);
		return { line, col: (this.state.lines[line] ?? "").length };
	}

	private placeholderOffsets(text: string): Array<{ start: number; end: number }> {
		return [...text.matchAll(PROMPT_PLACEHOLDER_REGEX)].map((match) => ({
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		}));
	}

	private selectOffsets(start: number, end: number): void {
		this.selectionAnchor = this.offsetToPosition(start);
		this.setCursor(this.offsetToPosition(end));
		this.tui.requestRender();
	}

	private selectFirstPlaceholderFromInsertion(textBefore: string, textAfter: string): void {
		if (textBefore === textAfter) return;

		let changedStart = 0;
		const sharedPrefixLimit = Math.min(textBefore.length, textAfter.length);
		while (changedStart < sharedPrefixLimit && textBefore[changedStart] === textAfter[changedStart]) {
			changedStart++;
		}

		let sharedSuffix = 0;
		while (
			sharedSuffix < textBefore.length - changedStart &&
			sharedSuffix < textAfter.length - changedStart &&
			textBefore[textBefore.length - 1 - sharedSuffix] === textAfter[textAfter.length - 1 - sharedSuffix]
		) {
			sharedSuffix++;
		}

		const changedEnd = textAfter.length - sharedSuffix;
		const firstInsertedPlaceholder = this.placeholderOffsets(textAfter).find(
			(placeholder) => placeholder.start >= changedStart && placeholder.end <= changedEnd,
		);
		if (!firstInsertedPlaceholder) return;

		this.selectOffsets(firstInsertedPlaceholder.start, firstInsertedPlaceholder.end);
	}

	private selectNextPromptPlaceholder(): boolean {
		const placeholders = this.placeholderOffsets(this.getCurrentRawText());
		if (placeholders.length === 0) return false;

		const selection = this.getSelectionRange();
		const searchOffset = selection
			? this.positionToOffset(selection.end)
			: this.positionToOffset(this.currentPos());
		const next = placeholders.find((placeholder) => placeholder.start >= searchOffset);

		if (next) {
			this.selectOffsets(next.start, next.end);
			return true;
		}

		const first = placeholders[0];
		if (first) {
			this.selectOffsets(first.start, first.end);
			return true;
		}

		return false;
	}

	private isInSlashAutocompleteContext(): boolean {
		const cursor = this.currentPos();
		const beforeCursor = (this.state.lines[cursor.line] ?? "").slice(0, cursor.col);
		return /(?:^|[ \t])\/[a-zA-Z0-9._:-]*$/.test(beforeCursor);
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

	private expandPasteMarkers(text: string): string {
		return text.replace(PASTE_MARKER_REGEX, (marker, idText: string) => {
			return this.i.pastes.get(Number(idText)) ?? marker;
		});
	}

	private pruneUnusedPasteMarkers(): void {
		const referencedIds = new Set<number>();
		for (const line of this.state.lines) {
			for (const match of line.matchAll(PASTE_MARKER_REGEX)) {
				referencedIds.add(Number(match[1]));
			}
		}
		for (const id of this.i.pastes.keys()) {
			if (!referencedIds.has(id)) this.i.pastes.delete(id);
		}
	}

	private clonePasteMarkers(text: string, cursorCol: number): { text: string; cursorCol: number } {
		let clonedCursorCol = cursorCol;
		const clonedText = text.replace(
			PASTE_MARKER_REGEX,
			(marker, idText: string, suffix: string | undefined, offset: number) => {
				const content = this.i.pastes.get(Number(idText));
				if (content === undefined) return marker;

				do this.i.pasteCounter++;
				while (this.i.pastes.has(this.i.pasteCounter));
				this.i.pastes.set(this.i.pasteCounter, content);
				const clonedMarker = `[paste #${this.i.pasteCounter}${suffix ?? ""}]`;
				if (offset + marker.length <= cursorCol) clonedCursorCol += clonedMarker.length - marker.length;
				return clonedMarker;
			},
		);
		return { text: clonedText, cursorCol: clonedCursorCol };
	}

	private getSelectedText(): string | null {
		const range = this.getSelectionRange();
		if (!range) return null;

		const lines = this.state.lines;
		if (range.start.line === range.end.line) {
			return this.expandPasteMarkers((lines[range.start.line] || "").slice(range.start.col, range.end.col));
		}

		const parts: string[] = [];
		parts.push((lines[range.start.line] || "").slice(range.start.col));
		for (let line = range.start.line + 1; line < range.end.line; line++) {
			parts.push(lines[line] || "");
		}
		parts.push((lines[range.end.line] || "").slice(0, range.end.col));
		return this.expandPasteMarkers(parts.join("\n"));
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

	private maybeTriggerInlineSlashAutocomplete(): void {
		if (this.isShowingAutocomplete()) return;
		const cursor = this.getCursor();
		const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		const match = beforeCursor.match(/(?:^|[ \t])(\/[a-zA-Z0-9._:-]*)$/);
		if (!match) return;

		const prefix = match[1] ?? "";
		const tokenStart = cursor.col - prefix.length;
		if (cursor.line === 0 && beforeCursor.slice(0, tokenStart).trim() === "") return;
		this.i.tryTriggerAutocomplete();
	}

	private handleAutocompleteSelectionAction(data: string): boolean {
		if (!this.isShowingAutocomplete()) return false;

		if (matchesKey(data, "ctrl+a")) {
			this.i.cancelAutocomplete();
			this.selectAll();
			return true;
		}
		if (matchesKey(data, "ctrl+c") && this.hasSelection()) {
			const selectedText = this.getSelectedText();
			this.i.cancelAutocomplete();
			this.clearSelection();
			this.tui.requestRender();
			if (selectedText != null) this.copyTextToClipboard(selectedText);
			return true;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.i.cancelAutocomplete();
			if (this.hasSelection()) {
				const selectedText = this.getSelectedText();
				this.deleteSelection(true);
				if (selectedText != null) this.copyTextToClipboard(selectedText);
			} else {
				this.cutCurrentLine();
			}
			return true;
		}

		const select = (mover: () => void): true => {
			this.i.cancelAutocomplete();
			this.moveWithSelection(mover);
			return true;
		};
		if (matchesKey(data, "shift+left")) return select(() => this.i.moveCursor(0, -1));
		if (matchesKey(data, "shift+right")) return select(() => this.i.moveCursor(0, 1));
		if (matchesKey(data, "shift+up")) return select(() => this.i.moveCursor(-1, 0));
		if (matchesKey(data, "shift+down")) return select(() => this.i.moveCursor(1, 0));
		if (matchesKey(data, "shift+home")) return select(() => this.i.moveToLineStart());
		if (matchesKey(data, "shift+end")) return select(() => this.i.moveToLineEnd());
		if (matchesKey(data, "shift+pageUp")) return select(() => this.i.pageScroll(-1));
		if (matchesKey(data, "shift+pageDown")) return select(() => this.i.pageScroll(1));
		if (matchesKey(data, "ctrl+shift+left") || matchesKey(data, "alt+shift+left")) {
			return select(() => this.i.moveWordBackwards());
		}
		if (matchesKey(data, "ctrl+shift+right") || matchesKey(data, "alt+shift+right")) {
			return select(() => this.i.moveWordForwards());
		}
		if (matchesKey(data, "ctrl+shift+home")) return select(() => this.moveToDocumentStart());
		if (matchesKey(data, "ctrl+shift+end")) return select(() => this.moveToDocumentEnd());

		return false;
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
		this.pruneUnusedPasteMarkers();
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
		const cutText = this.expandPasteMarkers(lines[lineIndex] ?? "");

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

		this.pruneUnusedPasteMarkers();
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
		const duplicatedLine = this.clonePasteMarkers(line, targetCol);
		this.state.lines.splice(lineIndex + 1, 0, duplicatedLine.text);
		this.state.cursorLine = lineIndex + 1;
		this.i.setCursorCol(Math.min(duplicatedLine.cursorCol, duplicatedLine.text.length));
		this.clearSelection();
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private pieceWithSelection(text: string, pieceStartCol: number, lineNumber: number, range: Range | null): string {
		if (text.length === 0) return text;
		const pieceEndCol = pieceStartCol + text.length;
		const boundaries = new Set([0, text.length]);
		const addBoundary = (absoluteCol: number): void => {
			const localCol = absoluteCol - pieceStartCol;
			if (localCol > 0 && localCol < text.length) boundaries.add(localCol);
		};

		let selectionStart = Number.POSITIVE_INFINITY;
		let selectionEnd = Number.NEGATIVE_INFINITY;
		if (range && lineNumber >= range.start.line && lineNumber <= range.end.line) {
			selectionStart = lineNumber === range.start.line ? range.start.col : 0;
			selectionEnd = lineNumber === range.end.line ? range.end.col : Number.POSITIVE_INFINITY;
			addBoundary(Math.max(pieceStartCol, selectionStart));
			addBoundary(Math.min(pieceEndCol, selectionEnd));
		}

		const completion = this.inlinePromptCompletion;
		if (completion?.line === lineNumber) {
			addBoundary(completion.counterStartCol);
			addBoundary(completion.endCol);
		}

		const points = [...boundaries].sort((a, b) => a - b);
		let result = "";
		for (let index = 0; index < points.length - 1; index++) {
			const localStart = points[index]!;
			const localEnd = points[index + 1]!;
			const absoluteStart = pieceStartCol + localStart;
			const part = text.slice(localStart, localEnd);
			if (absoluteStart >= selectionStart && absoluteStart < selectionEnd) {
				result += REVERSE + part + RESET;
			} else if (
				completion?.line === lineNumber &&
				absoluteStart >= completion.counterStartCol &&
				absoluteStart < completion.endCol
			) {
				result += this.inlinePromptCounterColor(part);
			} else {
				result += part;
			}
		}
		return result;
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
		const emitCursorMarker = this.focused;

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
				const visibleIndicator = truncateToWidth(historyIndicator, width, "");
				const indicatorWidth = visibleWidth(visibleIndicator);
				const leftWidth = Math.max(0, width - indicatorWidth - 2);
				const rightWidth = Math.max(0, width - leftWidth - indicatorWidth);
				result.push(
					this.borderColor("─".repeat(leftWidth)) +
					this.borderColor(visibleIndicator) +
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
		if (this.handleInlinePromptCompletionInput(data)) return;
		if (this.inlinePromptContinuation && this.getInlinePromptInputKind(data) === null) {
			this.inlinePromptContinuation = null;
		}
		if (this.handleCustomPasteInput(data)) return;
		// Any non-paste input (movement, editing, commands, etc.) cancels the
		// double-paste gesture, even if it later leaves the cursor where it was.
		this.pendingInlinePaste = null;
		if (this.shouldDropAhkLeakedAltEnye(data)) return;
		if (this.handleAutocompleteSelectionAction(data)) return;
		const isTab = matchesKey(data, "tab");
		const acceptingAutocompleteWithTab = isTab && this.isShowingAutocomplete();

		// 0) Undo/redo. Handle these before `super.handleInput()` so Ctrl+Z
		// wins over pi's app.suspend binding on Unix-like terminals, and Ctrl+Y
		// overrides the base editor's yank binding.
		if (matchesKey(data, "ctrl+y") || matchesKey(data, "ctrl+shift+z")) {
			this.redo();
			return;
		}

		// Tab accepts an already-visible autocomplete menu. Otherwise it always
		// navigates any prompt placeholders in the editor, or is consumed so Pi
		// does not open native path completion. Slash contexts remain allowed to
		// explicitly open their menu.
		if (isTab && !acceptingAutocompleteWithTab) {
			if (this.selectNextPromptPlaceholder()) return;
			if (!this.isInSlashAutocompleteContext()) return;
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
		if (matchesKey(data, "escape") && this.hasSelection() && !this.isShowingAutocomplete()) {
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
		const textBeforeInput = this.getText();
		this.clearSelection();
		super.handleInput(data);
		if (this.getText() !== textBeforeInput) {
			this.pruneUnusedPasteMarkers();
			if (acceptingAutocompleteWithTab) {
				this.selectFirstPlaceholderFromInsertion(textBeforeInput, this.getText());
			}
			this.maybeTriggerInlineSlashAutocomplete();
			// Deletion may restore a matching prefix, but it must not summon inline
			// completion by itself. Preserve any dormant continuation and wait until
			// the user types another printable character.
			if (this.getInlinePromptInputKind(data) === "printable") {
				this.maybeActivateInlinePromptCompletion();
			}
		}
	}
}

export default function (pi: ExtensionAPI) {
	let activeEditor: SelectionEditor | null = null;

	pi.on("session_start", (_event, ctx) => {
		// The TUI accepts input before extension session_start handlers finish. Capture
		// the expanded value before Pi copies only the collapsed text into our editor.
		const expandedTextBeforeSwap = ctx.ui.getEditorText();
		const inlinePromptCandidates = loadInlinePromptCandidates(pi);
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			activeEditor = new SelectionEditor(inlinePromptCandidates, tui, theme, kb);
			return activeEditor;
		});
		activeEditor?.restoreTransferredText(expandedTextBeforeSwap);
	});

	pi.on("before_agent_start", () => {
		activeEditor?.resetAfterSubmit();
	});
}
