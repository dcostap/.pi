import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BackgroundProcessSnapshot } from "../manager.ts";
import { sanitizeTerminalText } from "../sanitize.ts";

export interface OutputWindow {
	readonly lines: string[];
	readonly maxScrollFromBottom: number;
	readonly scrollFromBottom: number;
}

export function getOutputWindow(
	snapshot: BackgroundProcessSnapshot,
	width: number,
	height: number,
	scrollFromBottom: number,
): OutputWindow {
	const safeWidth = Math.max(1, width);
	const safeHeight = Math.max(1, height);
	const sanitized = sanitizeTerminalText(snapshot.output.text).replace(/\s+$/u, "");
	const source = sanitized ? sanitized.split("\n").map((line) => truncateToWidth(line, safeWidth, "…")) : [snapshot.settled ? "(no output)" : "(no output yet)"];
	const maxScrollFromBottom = Math.max(0, source.length - safeHeight);
	const boundedScroll = Math.max(0, Math.min(maxScrollFromBottom, scrollFromBottom));
	const end = source.length - boundedScroll;
	const start = Math.max(0, end - safeHeight);
	return {
		lines: source.slice(start, end),
		maxScrollFromBottom,
		scrollFromBottom: boundedScroll,
	};
}
