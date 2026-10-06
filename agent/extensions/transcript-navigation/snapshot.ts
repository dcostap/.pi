import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TranscriptBlock, TranscriptSnapshot } from "./reader.ts";

type ScrollView = { scrollTop: number; scrollTo?(top: number, options: { disableFollow: boolean }): void };
type RenderedComponent = {
	constructor: { name: string };
	text?: string;
	mouseLayout?: { children: { component: RenderedComponent; height: number }[] };
};
type LayoutBox = {
	scrollView?: ScrollView; scrollContentLines?: readonly string[]; children: LayoutBox[];
	component?: RenderedComponent; rect?: { y: number; height: number };
};

/** Container's cached child heights match the captured buffer, including folded thinking. */
function textBlocks(box: LayoutBox, lines: string[], top: number): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	const add = (startRow: number, height: number) => {
		let endRow = Math.min(lines.length - 1, startRow + height - 1);
		startRow = Math.max(0, startRow);
		while (startRow <= endRow && !lines[startRow]!.trim()) startRow++;
		while (endRow >= startRow && !lines[endRow]!.trim()) endRow--;
		if (startRow <= endRow) blocks.push({ startRow, endRow });
	};
	const visitComponent = (component: RenderedComponent, row: number) => {
		const name = component.constructor.name;
		if (name === "AssistantMessageComponent") {
			// Direct Markdown children are text. Thinking uses a MouseRegion wrapper.
			for (const child of component.mouseLayout?.children ?? []) {
				let contentRow = row;
				for (const content of child.component.mouseLayout?.children ?? []) {
					if (content.component.constructor.name === "Markdown") add(contentRow, content.height);
					contentRow += content.height;
				}
				row += child.height;
			}
			return;
		}
		if (name === "UserMessageComponent") {
			for (const child of component.mouseLayout?.children ?? []) {
				if (child.component.constructor.name === "Markdown" && component.text?.trim()) add(row, child.height);
				row += child.height;
			}
			return;
		}
		for (const child of component.mouseLayout?.children ?? []) {
			visitComponent(child.component, row);
			row += child.height;
		}
	};
	const visitBox = (child: LayoutBox) => {
		if (child.children.length) child.children.forEach(visitBox);
		else if (child.component && child.rect && box.rect) {
			visitComponent(child.component, child.rect.y - box.rect.y + top);
		}
	};
	box.children.forEach(visitBox);
	return blocks;
}

/** Keep text styles and links, but remove cursor, shell, and other terminal controls. */
function styledText(line: string): string {
	return line.split(/(\x1b\[[\d;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/g)
		.map((part, index) => index % 2 ? part : stripTerminalSequences(part)).join("");
}

/** Pi 1.0 has no public transcript-buffer getter. Keep this one private access here. */
function transcriptBox(tui: unknown): LayoutBox | undefined {
	const runtime = tui as {
		mode?: string;
		currentLayout?: { root: LayoutBox; primaryScrollView?: ScrollView };
	};
	const layout = runtime.currentLayout;
	if (runtime.mode !== "fullscreen" || !layout?.primaryScrollView) return;

	const find = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === layout.primaryScrollView) return box;
		for (const child of box.children) {
			const match = find(child);
			if (match) return match;
		}
	};
	return find(layout.root);
}

/** Move the native view before closing the overlay, so the next frame keeps its position. */
export function scrollRenderedTranscript(tui: unknown, top: number): void {
	const box = transcriptBox(tui);
	// The reader starts at screen row zero; the native transcript can start below a header.
	box?.scrollView?.scrollTo?.(top + (box.rect?.y ?? 0), { disableFollow: true });
}

export function readRenderedTranscript(tui: unknown): TranscriptSnapshot | undefined {
	const box = transcriptBox(tui);
	if (!box?.scrollContentLines) return;
	const styledLines = box.scrollContentLines.map((line) =>
		line.includes("\x1b_G") || line.includes("\x1b]1337;File=")
			? "[image]" : styledText(line));
	const lines = styledLines.map((line) => stripTerminalSequences(line).trimEnd());
	return {
		lines,
		styledLines,
		top: box.scrollView!.scrollTop,
		height: box.rect?.height,
		blocks: textBlocks(box, lines, box.scrollView!.scrollTop),
	};
}
