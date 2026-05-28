import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { createReadStream, realpathSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

type ReadArgs = {
	path?: string;
	offset?: number;
	limit?: number;
};

type TextBlock = {
	type: "text";
	text?: string;
};

type ImageBlock = {
	type: "image";
	data?: string;
	mimeType?: string;
};

type ReadResult = {
	content: Array<TextBlock | ImageBlock | { type: string; text?: string }>;
	details?: {
		truncation?: {
			truncated?: boolean;
			outputLines?: number;
			firstLineExceedsLimit?: boolean;
		};
	};
};

type ReadCoverage = {
	startLine: number;
	endLine: number;
	totalLines: number;
};

type LineRange = {
	startLine: number;
	endLine: number;
};

type FileCoverageState = {
	versionKey: string;
	totalLines: number;
	ranges: LineRange[];
	lastTouched: number;
};

type CoverageSnapshot = {
	beforeCoveredLines: number;
	afterCoveredLines: number;
	totalLines: number;
	estimatedInputTokens: number;
};

const SHOWING_RE = /\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^)]+\))?\. Use offset=\d+ to continue\.\]$/;
const MORE_RE = /\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;
const MAX_TRACKED_FILES = 30;

function countLines(text: string): number {
	return text === "" ? 1 : text.split("\n").length;
}

function trimContinuationFooter(text: string): string {
	return text.replace(/\n\n(?:\[Showing lines .*?\]|\[\d+ more lines in file\. Use offset=\d+ to continue\.\])$/, "");
}

function parseCoverage(args: ReadArgs | undefined, result: ReadResult): ReadCoverage | null {
	const textBlock = result.content.find((block): block is TextBlock => block.type === "text");
	if (!textBlock?.text) return null;

	const text = textBlock.text;
	const offset = args?.offset ?? 1;

	if (/^Read image file \[.+\]/.test(text)) return null;
	if (/^\[Line \d+ is .* exceeds .* limit\./.test(text)) return null;

	const showingMatch = text.match(SHOWING_RE);
	if (showingMatch) {
		return {
			startLine: Number(showingMatch[1]),
			endLine: Number(showingMatch[2]),
			totalLines: Number(showingMatch[3]),
		};
	}

	const moreMatch = text.match(MORE_RE);
	if (moreMatch) {
		const remainingLines = Number(moreMatch[1]);
		const nextOffset = Number(moreMatch[2]);
		const startLine = offset;
		const endLine = nextOffset - 1;
		return {
			startLine,
			endLine,
			totalLines: endLine + remainingLines,
		};
	}

	const shownText = trimContinuationFooter(text);
	const shownLines = result.details?.truncation?.truncated
		? (result.details.truncation.outputLines ?? countLines(shownText))
		: countLines(shownText);
	const startLine = offset;
	const endLine = shownLines > 0 ? startLine + shownLines - 1 : startLine - 1;
	const totalLines = Math.max(endLine, startLine - 1);
	if (endLine < startLine || totalLines <= 0) return null;

	return {
		startLine,
		endLine,
		totalLines,
	};
}

function normalizePath(path: string | undefined): string | null {
	if (!path) return null;
	return path.startsWith("@") ? path.slice(1) : path;
}

function getCanonicalFileKey(cwd: string, path: string | undefined): string | null {
	const normalizedPath = normalizePath(path);
	if (!normalizedPath) return null;

	const absolutePath = isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath);
	try {
		return realpathSync(absolutePath);
	} catch {
		return absolutePath;
	}
}

function getVersionKey(fileKey: string): string {
	try {
		const stats = statSync(fileKey);
		return `${fileKey}:${stats.mtimeMs}:${stats.size}`;
	} catch {
		return `unknown:${fileKey}`;
	}
}

async function countFileLines(fileKey: string): Promise<number> {
	const stream = createReadStream(fileKey);
	let lineCount = 0;
	let sawAnyBytes = false;
	let lastByteWasLf = false;

	try {
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (buffer.length === 0) continue;

			sawAnyBytes = true;
			for (let i = 0; i < buffer.length; i++) {
				if (buffer[i] === 10) lineCount++;
			}
			lastByteWasLf = buffer[buffer.length - 1] === 10;
		}
	} finally {
		stream.destroy();
	}

	if (!sawAnyBytes) return 1;
	return lastByteWasLf ? lineCount : lineCount + 1;
}

function clampRange(range: ReadCoverage): LineRange {
	const maxLine = Math.max(1, range.totalLines);
	return {
		startLine: Math.max(1, Math.min(range.startLine, maxLine)),
		endLine: Math.max(1, Math.min(range.endLine, maxLine)),
	};
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
	if (ranges.length <= 1) return ranges.slice();

	const sorted = ranges
		.slice()
		.sort((a, b) => (a.startLine - b.startLine) || (a.endLine - b.endLine));
	const merged: LineRange[] = [];

	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (!last || range.startLine > last.endLine + 1) {
			merged.push({ ...range });
			continue;
		}
		last.endLine = Math.max(last.endLine, range.endLine);
	}

	return merged;
}

function addRange(ranges: LineRange[], nextRange: LineRange): LineRange[] {
	if (nextRange.endLine < nextRange.startLine) return ranges.slice();
	return mergeRanges([...ranges, nextRange]);
}

function getCoveredLines(ranges: LineRange[]): number {
	return ranges.reduce((total, range) => total + (range.endLine - range.startLine + 1), 0);
}

function roundPercent(lines: number, totalLines: number): number {
	if (totalLines <= 0) return 0;
	const percent = (lines / totalLines) * 100;
	return Math.max(0, Math.min(100, Math.round(percent)));
}

function formatDelta(snapshot: CoverageSnapshot): string | null {
	if (snapshot.totalLines <= 0) return null;
	if (snapshot.beforeCoveredLines <= 0) return null;

	const deltaLines = snapshot.afterCoveredLines - snapshot.beforeCoveredLines;
	if (deltaLines <= 0) return null;

	const deltaPercent = (deltaLines / snapshot.totalLines) * 100;
	const rounded = Math.round(deltaPercent);
	if (rounded === 0) return "+<1%";
	return `+${rounded}%`;
}

function formatTokenEstimate(tokens: number): string {
	if (tokens >= 1000) {
		const thousands = tokens / 1000;
		return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
	}
	return `${tokens}`;
}

function estimateInputTokens(result: ReadResult): number {
	let chars = 0;
	for (const block of result.content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		if (block.type === "image" && block.data) chars += block.data.length;
	}

	// Cheap approximation used only for display. Text tokenization is commonly
	// around 4 characters/token; base64 image payloads are closer to 1 token/char,
	// but read normally returns text for this coverage use-case.
	return Math.max(1, Math.round(chars / 4));
}

function formatCoverageFooter(snapshot: CoverageSnapshot): string {
	const totalCoverage = `${roundPercent(snapshot.afterCoveredLines, snapshot.totalLines)}%`;
	const delta = formatDelta(snapshot);
	const tokenEstimate = `↑${formatTokenEstimate(snapshot.estimatedInputTokens)}`;
	const coverage = delta ? `[Coverage: ${totalCoverage}] (${delta})` : `[Coverage: ${totalCoverage}]`;
	return `${coverage} ${tokenEstimate}`;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const original = createReadToolDefinition(cwd);
	const fileCoverage = new Map<string, FileCoverageState>();
	const lineCountsByVersionKey = new Map<string, number>();
	const snapshotsByToolCallId = new Map<string, CoverageSnapshot>();
	let touchCounter = 0;

	async function getTotalLines(fileKey: string, versionKey: string, fallbackTotalLines: number): Promise<number> {
		const cached = lineCountsByVersionKey.get(versionKey);
		if (cached !== undefined) return cached;

		if (versionKey.startsWith("unknown:")) return fallbackTotalLines;

		try {
			const totalLines = await countFileLines(fileKey);
			lineCountsByVersionKey.set(versionKey, totalLines);
			return totalLines;
		} catch {
			return fallbackTotalLines;
		}
	}

	function maybeDropLineCount(versionKey: string, ignoredFileKey?: string) {
		for (const [trackedFileKey, state] of fileCoverage) {
			if (trackedFileKey !== ignoredFileKey && state.versionKey === versionKey) return;
		}
		lineCountsByVersionKey.delete(versionKey);
	}

	function resetState() {
		fileCoverage.clear();
		lineCountsByVersionKey.clear();
		snapshotsByToolCallId.clear();
		touchCounter = 0;
	}

	function evictOldFiles() {
		if (fileCoverage.size <= MAX_TRACKED_FILES) return;

		let oldestKey: string | null = null;
		let oldestTouch = Number.POSITIVE_INFINITY;
		for (const [fileKey, state] of fileCoverage) {
			if (state.lastTouched < oldestTouch) {
				oldestTouch = state.lastTouched;
				oldestKey = fileKey;
			}
		}

		if (oldestKey) {
			const evictedState = fileCoverage.get(oldestKey);
			fileCoverage.delete(oldestKey);
			if (evictedState) maybeDropLineCount(evictedState.versionKey);
		}
	}

	pi.on("session_start", async () => resetState());
	pi.on("session_tree", async () => resetState());

	pi.registerTool({
		name: "read",
		label: original.label,
		description: original.description,
		promptSnippet: original.promptSnippet,
		promptGuidelines: original.promptGuidelines,
		parameters: original.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await original.execute(toolCallId, params, signal, onUpdate, ctx);
			const coverage = parseCoverage(params as ReadArgs | undefined, result as ReadResult);
			if (!coverage) return result;

			const fileKey = getCanonicalFileKey(ctx.cwd, (params as ReadArgs | undefined)?.path);
			if (!fileKey) return result;

			const versionKey = getVersionKey(fileKey);
			const totalLines = await getTotalLines(fileKey, versionKey, coverage.totalLines);
			const nextRange = clampRange({ ...coverage, totalLines });
			const existingState = fileCoverage.get(fileKey);
			if (existingState && existingState.versionKey !== versionKey) {
				maybeDropLineCount(existingState.versionKey, fileKey);
			}
			const state = !existingState || existingState.versionKey !== versionKey
				? {
					versionKey,
					totalLines,
					ranges: [] as LineRange[],
					lastTouched: 0,
				}
				: existingState;

			const beforeCoveredLines = getCoveredLines(state.ranges);
			state.ranges = addRange(state.ranges, nextRange);
			state.totalLines = totalLines;
			state.lastTouched = ++touchCounter;
			fileCoverage.set(fileKey, state);
			evictOldFiles();

			snapshotsByToolCallId.set(toolCallId, {
				beforeCoveredLines,
				afterCoveredLines: getCoveredLines(state.ranges),
				totalLines,
				estimatedInputTokens: estimateInputTokens(result as ReadResult),
			});

			return result;
		},

		renderResult(result, options, theme, context) {
			const innerContext = {
				...context,
				lastComponent: context.state.__originalReadResultComponent,
			};
			const baseComponent = original.renderResult
				? original.renderResult(result, options, theme, innerContext)
				: new Text("", 0, 0);
			context.state.__originalReadResultComponent = baseComponent;

			const snapshot = snapshotsByToolCallId.get(context.toolCallId);
			if (!snapshot) return baseComponent;

			const footer = new Text(theme.fg("muted", formatCoverageFooter(snapshot)), 0, 0);
			const container = new Container();
			container.addChild(baseComponent);
			container.addChild(new Spacer(1));
			container.addChild(footer);
			return container;
		},
	});
}
