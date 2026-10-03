import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TranscriptSnapshot } from "./reader.ts";

type ScrollView = { scrollTop: number };
type LayoutBox = { scrollView?: ScrollView; scrollContentLines?: readonly string[]; children: LayoutBox[] };

/** Keep text styles and links, but remove cursor, shell, and other terminal controls. */
function styledText(line: string): string {
	return line.split(/(\x1b\[[\d;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/g)
		.map((part, index) => index % 2 ? part : stripTerminalSequences(part)).join("");
}

/** Pi 1.0 has no public transcript-buffer getter. Keep this one private access here. */
export function readRenderedTranscript(tui: unknown): TranscriptSnapshot | undefined {
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
	const box = find(layout.root);
	if (!box?.scrollContentLines) return;
	const styledLines = box.scrollContentLines.map((line) =>
		line.includes("\x1b_G") || line.includes("\x1b]1337;File=")
			? "[image]" : styledText(line));
	return {
		lines: styledLines.map((line) => stripTerminalSequences(line).trimEnd()),
		styledLines,
		top: layout.primaryScrollView.scrollTop,
	};
}
