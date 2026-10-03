// Pi does not expose selection hit tests or selection clearing in its extension API.
// Keep the internal method access here, and check it before installing the handler.
interface MouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface ScrollState {
	scrollTop: number;
}

interface SelectionPoint {
	row: number;
	col: number;
	boundary?: boolean;
	scrollView?: ScrollState;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
	scrollView?: ScrollState;
}

interface SelectionTui {
	currentLayout?: { root: LayoutBox };
	selectionPressActive?: boolean;
	mouseCapture?: unknown;
	mousePressTarget?: unknown;
	scrollbarDrag?: unknown;
	handleMouseEvent(event: MouseEvent): void;
	hasOverlay(): boolean;
	getSelectionBounds(): SelectionRange | undefined;
	getSelectionSourceLine(point: SelectionPoint): string;
	getSelectionColumns(line: string, row: number, range: SelectionRange): { start: number; end: number };
	copyActiveSelectionToClipboard(): Promise<boolean>;
	clearTextSelection(): void;
	requestRender(): void;
	flash(message: string, durationMs?: number): void;
}

const PATCH = Symbol.for("pi.fullscreen-right-click-copy");

function findScrollBox(box: LayoutBox, scrollView: ScrollState): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

function contains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function hitsSelection(tui: SelectionTui, event: MouseEvent, range: SelectionRange): boolean {
	let row = event.y;
	let col = event.x;
	const scrollView = range.start.scrollView;
	if (scrollView) {
		const box = tui.currentLayout && findScrollBox(tui.currentLayout.root, scrollView);
		if (!box || !contains(box.rect, event.x, event.y) || !contains(box.clip, event.x, event.y)) return false;
		row = scrollView.scrollTop + event.y - box.rect.y;
		col = event.x - box.rect.x;
	}
	if (row < range.start.row || row > range.end.row) return false;
	const line = tui.getSelectionSourceLine({ row, col, scrollView });
	const columns = tui.getSelectionColumns(line, row, range);
	return col >= columns.start && col < columns.end;
}

/** Install once per fullscreen prototype. Return undefined if Pi changed the required methods. */
export function installRightClickCopy(prototype: unknown): (() => void) | undefined {
	if (!prototype || typeof prototype !== "object") return undefined;
	const properties = prototype as Record<PropertyKey, unknown>;
	const methods = [
		"handleMouseEvent", "hasOverlay", "getSelectionBounds", "getSelectionSourceLine",
		"getSelectionColumns", "copyActiveSelectionToClipboard", "clearTextSelection", "requestRender", "flash",
	];
	if (methods.some((method) => typeof properties[method] !== "function")) return undefined;
	// A reload replaces the old patch, rather than adding another wrapper.
	if (typeof properties[PATCH] === "function") (properties[PATCH] as () => void)();
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouseEvent");
	const original = properties.handleMouseEvent as SelectionTui["handleMouseEvent"];
	const pending = new WeakSet<SelectionTui>();
	let active = true;

	function handleMouseEvent(this: SelectionTui, event: MouseEvent): void {
		if (
			!active || event.release || event.button !== 2 || this.hasOverlay() || this.selectionPressActive ||
			this.mouseCapture || this.mousePressTarget || this.scrollbarDrag
		) {
			original.call(this, event);
			return;
		}
		const selection = this.getSelectionBounds();
		if (!selection || !hitsSelection(this, event, selection)) {
			original.call(this, event);
			return;
		}
		if (pending.has(this)) return;
		pending.add(this);
		void this.copyActiveSelectionToClipboard().then((copied) => {
			if (!active || !copied) return;
			const current = this.getSelectionBounds();
			// Do not clear a selection made while the clipboard write was in progress.
			if (current?.start !== selection.start || current.end !== selection.end) return;
			this.clearTextSelection();
			this.requestRender();
		}).catch(() => {
			if (active) this.flash("Copy failed", 5000);
		}).finally(() => pending.delete(this));
	}

	function restore(): void {
		active = false;
		if (properties.handleMouseEvent === handleMouseEvent) {
			if (descriptor) Object.defineProperty(prototype, "handleMouseEvent", descriptor);
			else delete properties.handleMouseEvent;
		}
		if (properties[PATCH] === restore) delete properties[PATCH];
	}

	properties.handleMouseEvent = handleMouseEvent;
	properties[PATCH] = restore;
	return restore;
}
