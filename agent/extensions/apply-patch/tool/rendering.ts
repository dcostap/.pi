import { isAbsolute, relative } from "node:path";
import { openFileAtPath } from "../patch/paths.ts";
import { parsePatchActions } from "../patch/parser.ts";
import type { ParsedPatchAction } from "../patch/types.ts";

const VISUAL_CONTEXT_LINES = 3;
const OVERLAP_CONTEXT_LINES = 5;

interface PreviewLine {
	lineNumber: number;
	marker: " " | "+" | "-";
	text: string;
	separator?: boolean;
}

interface ResolvedUpdateSection {
	lines: PreviewLine[];
	sourceStart: number;
	sourceLength: number;
	contextStart: number;
	contextEnd: number;
	overlapStart: number;
	overlapEnd: number;
	readingPatchedFile: boolean;
	deltaBefore: number;
	delta: number;
}

interface UpdateSectionGroup {
	sections: ResolvedUpdateSection[];
	contextStart: number;
	contextEnd: number;
	overlapEnd: number;
	readingPatchedFile: boolean;
}

interface FilePreview {
	verb: "Added" | "Deleted" | "Edited";
	path: string;
	movePath?: string | undefined;
	added: number;
	removed: number;
	lines: PreviewLine[];
	wholeFileDelete?: boolean;
}

export function formatApplyPatchSummary(patchText: string, cwd = process.cwd()): string {
	let actions: ParsedPatchAction[];
	try {
		actions = parsePatchActions({ text: patchText });
	} catch {
		return "";
	}

	const files = actions.map((action) => buildFilePreview(action, cwd));
	if (files.length === 0) {
		return "";
	}

	const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
	const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
	const lines: string[] = [];

	if (files.length === 1) {
		const file = files[0]!;
		lines.push(`${bulletHeader(file.verb, formatPatchTarget(file.path, file.movePath, cwd))} ${renderCounts(file.added, file.removed)}`);
		return lines.join("\n");
	}

	lines.push(`${bulletHeader("Edited", `${files.length} files`)} ${renderCounts(totalAdded, totalRemoved)}`);
	for (const [index, file] of files.entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		lines.push(`${prefix}${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`);
	}

	return lines.join("\n");
}

export function formatApplyPatchCall(patchText: string, cwd = process.cwd()): string {
	let actions: ParsedPatchAction[];
	try {
		actions = parsePatchActions({ text: patchText });
	} catch {
		return "";
	}

	const files = actions.map((action) => buildFilePreview(action, cwd));
	if (files.length === 0) {
		return "";
	}

	const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
	const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
	const lines: string[] = [];

	if (files.length === 1) {
		const file = files[0]!;
		lines.push(`${bulletHeader(file.verb, formatPatchTarget(file.path, file.movePath, cwd))} ${renderCounts(file.added, file.removed)}`);
		lines.push(...formatFilePreview(file));
		return lines.join("\n");
	}

	lines.push(`${bulletHeader("Edited", `${files.length} files`)} ${renderCounts(totalAdded, totalRemoved)}`);
	for (const [index, file] of files.entries()) {
		if (index > 0 && (hasFilePreview(files[index - 1]!) || hasFilePreview(file))) {
			lines.push("");
		}
		lines.push(`  └ ${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`);
		lines.push(...formatFilePreview(file, "    "));
	}

	return lines.join("\n");
}

export function formatApplyPatchCollapsedDiff(patchText: string, cwd = process.cwd()): string {
	return renderApplyPatchCall(patchText, cwd) || formatApplyPatchSummary(patchText, cwd);
}

export function renderApplyPatchCall(patchText: string, cwd = process.cwd()): string {
	let actions: ParsedPatchAction[];
	try {
		actions = parsePatchActions({ text: patchText });
	} catch {
		return "";
	}

	const files = actions.map((action) => buildFilePreview(action, cwd));
	if (files.length === 0) {
		return "";
	}

	const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
	const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
	const lines: string[] = [];

	if (files.length === 1) {
		const file = files[0]!;
		lines.push(`${bulletHeader(file.verb, formatPatchTarget(file.path, file.movePath, cwd))} ${renderCounts(file.added, file.removed)}`);
		lines.push(...renderFilePreview(file));
		return lines.join("\n");
	}

	lines.push(`${bulletHeader("Edited", `${files.length} files`)} ${renderCounts(totalAdded, totalRemoved)}`);
	for (const [index, file] of files.entries()) {
		if (index > 0 && (hasFilePreview(files[index - 1]!) || hasFilePreview(file))) {
			lines.push("");
		}
		lines.push(`  └ ${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`);
		lines.push(...renderFilePreview(file, "    "));
	}

	return lines.join("\n");
}

function buildFilePreview(action: ParsedPatchAction, cwd: string): FilePreview {
	if (action.type === "add") {
		const lines = splitFileLines(action.newFile ?? "");
		return {
			verb: "Added",
			path: action.path,
			added: lines.length,
			removed: 0,
			lines: lines.map((text, index) => ({ lineNumber: index + 1, marker: "+", text })),
		};
	}

	if (action.type === "delete") {
		const removed = readFileLines(action.path, cwd).length;
		return {
			verb: "Deleted",
			path: action.path,
			added: 0,
			removed,
			// A Delete File action contains only the path. Showing every old line
			// makes it look as though the model emitted a giant deletion hunk.
			lines: [],
			wholeFileDelete: true,
		};
	}

	const preview = buildUpdatePreview(action, cwd);
	return {
		verb: "Edited",
		path: action.path,
		movePath: action.movePath,
		added: preview.added,
		removed: preview.removed,
		lines: preview.lines,
	};
}

function buildUpdatePreview(action: ParsedPatchAction, cwd: string): { added: number; removed: number; lines: PreviewLine[] } {
	if (!action.lines) {
		return { added: 0, removed: 0, lines: [] };
	}

	const originalLines = readFileLines(action.path, cwd);
	const sections: ResolvedUpdateSection[] = [];
	let added = 0;
	let removed = 0;
	let searchStart = 0;
	let delta = 0;
	let index = 0;

	while (index < action.lines.length) {
		const line = action.lines[index]!;
		if (line === "*** End of File") {
			break;
		}
		if (!line.startsWith("@@")) {
			index += 1;
			continue;
		}

		index += 1;
		const sectionLines: string[] = [];
		while (index < action.lines.length && !action.lines[index]!.startsWith("@@") && action.lines[index] !== "*** End of File") {
			sectionLines.push(action.lines[index]!);
			index += 1;
		}

		if (sectionLines.length === 0) {
			continue;
		}

		const normalizedLines = sectionLines.map(normalizePatchLine);
		const oldSequence = normalizedLines
			.filter((entry) => entry.marker === " " || entry.marker === "-")
			.map((entry) => entry.text);
		const newSequence = normalizedLines
			.filter((entry) => entry.marker === " " || entry.marker === "+")
			.map((entry) => entry.text);
		let sectionStart = findMatchingSequence(originalLines, oldSequence, searchStart);
		let readingPatchedFile = false;
		if (sectionStart === -1) {
			sectionStart = findMatchingSequence(originalLines, newSequence, searchStart);
			readingPatchedFile = sectionStart !== -1;
		}
		if (sectionStart === -1) sectionStart = searchStart;
		const contextStart = Math.max(0, sectionStart - VISUAL_CONTEXT_LINES);
		for (const entry of normalizedLines) {
			if (entry.marker === "+") added += 1;
			if (entry.marker === "-") removed += 1;
		}
		const sourceLength = readingPatchedFile ? newSequence.length : oldSequence.length;
		const sectionDelta = normalizedLines.reduce((sum, entry) => {
			const marker = entry.marker;
			if (marker === "+") return sum + 1;
			if (marker === "-") return sum - 1;
			return sum;
		}, 0);
		sections.push({
			lines: normalizedLines,
			sourceStart: sectionStart,
			sourceLength,
			contextStart,
			contextEnd: Math.min(originalLines.length, sectionStart + sourceLength + VISUAL_CONTEXT_LINES),
			overlapStart: Math.max(0, sectionStart - OVERLAP_CONTEXT_LINES),
			overlapEnd: Math.min(originalLines.length, sectionStart + sourceLength + OVERLAP_CONTEXT_LINES),
			readingPatchedFile,
			deltaBefore: delta,
			delta: sectionDelta,
		});

		searchStart = sectionStart + sourceLength;
		delta += sectionDelta;
	}

	const groups: UpdateSectionGroup[] = [];
	for (const section of sections) {
		const previous = groups.at(-1);
		// Use a wider range for deciding whether hunks belong together than for
		// their outer visual context. This avoids an ellipsis for only a few lines
		// between edits without making every standalone hunk show extra context.
		// Ranges are half-open, so equality means the check ranges touch.
		if (
			previous &&
			previous.readingPatchedFile === section.readingPatchedFile &&
			section.overlapStart <= previous.overlapEnd
		) {
			previous.sections.push(section);
			previous.contextEnd = Math.max(previous.contextEnd, section.contextEnd);
			previous.overlapEnd = Math.max(previous.overlapEnd, section.overlapEnd);
			continue;
		}
		groups.push({
			sections: [section],
			contextStart: section.contextStart,
			contextEnd: section.contextEnd,
			overlapEnd: section.overlapEnd,
			readingPatchedFile: section.readingPatchedFile,
		});
	}

	const renderedLines: PreviewLine[] = [];
	for (const [groupIndex, group] of groups.entries()) {
		if (groupIndex > 0) {
			renderedLines.push({ lineNumber: 0, marker: " ", text: "...", separator: true });
		}
		renderedLines.push(...renderUpdateSectionGroup(originalLines, group));
	}

	return { added, removed, lines: renderedLines };
}

function renderUpdateSectionGroup(originalLines: string[], group: UpdateSectionGroup): PreviewLine[] {
	const renderedLines: PreviewLine[] = [];
	let sourceIndex = group.contextStart;

	for (const section of group.sections) {
		const contextDelta = section.readingPatchedFile ? 0 : section.deltaBefore;
		while (sourceIndex < section.sourceStart) {
			renderedLines.push({
				lineNumber: sourceIndex + 1 + contextDelta,
				marker: " ",
				text: originalLines[sourceIndex]!,
			});
			sourceIndex += 1;
		}

		let oldLineNumber = section.readingPatchedFile
			? section.sourceStart + 1 - section.deltaBefore
			: section.sourceStart + 1;
		let newLineNumber = section.readingPatchedFile
			? section.sourceStart + 1
			: section.sourceStart + 1 + section.deltaBefore;
		for (const entry of section.lines) {
			if (entry.marker === "+") {
				renderedLines.push({ lineNumber: newLineNumber, marker: "+", text: entry.text });
				newLineNumber += 1;
				continue;
			}

			if (entry.marker === "-") {
				renderedLines.push({ lineNumber: oldLineNumber, marker: "-", text: entry.text });
				oldLineNumber += 1;
				continue;
			}

			renderedLines.push({ lineNumber: newLineNumber, marker: " ", text: entry.text });
			oldLineNumber += 1;
			newLineNumber += 1;
		}

		sourceIndex = section.sourceStart + section.sourceLength;
	}

	const finalSection = group.sections.at(-1)!;
	const finalDelta = finalSection.readingPatchedFile ? 0 : finalSection.deltaBefore + finalSection.delta;
	while (sourceIndex < group.contextEnd) {
		renderedLines.push({
			lineNumber: sourceIndex + 1 + finalDelta,
			marker: " ",
			text: originalLines[sourceIndex]!,
		});
		sourceIndex += 1;
	}

	return renderedLines;
}

function formatPreviewLine(line: PreviewLine, lines: PreviewLine[]): string {
	if (line.separator) return "        ...";
	const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
	return `    ${String(line.lineNumber).padStart(numberWidth, " ")} ${line.marker}${line.text}`;
}

function hasFilePreview(file: FilePreview): boolean {
	return !file.wholeFileDelete && file.lines.length > 0;
}

function formatFilePreview(file: FilePreview, indent = ""): string[] {
	if (file.wholeFileDelete) {
		return [];
	}
	return file.lines.map((line) => {
		const formatted = formatPreviewLine(line, file.lines);
		return indent ? `${indent}${formatted.trimStart()}` : formatted;
	});
}

function renderFilePreview(file: FilePreview, indent = ""): string[] {
	if (file.wholeFileDelete) {
		return [];
	}
	return renderPreviewLines(file.lines, indent);
}

function renderPreviewLines(lines: PreviewLine[], indent = ""): string[] {
	if (lines.length === 0) {
		return [];
	}

	const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
	// Keep cached previews semantic and ANSI-free. Styling them through
	// renderDiff() is unsafe inside a background-filled Box: intra-line inverse
	// spans can leave inverse active while Text pads a logical line, producing
	// the large black rectangles seen in Windows Terminal. It also bakes the
	// global theme into render-state caches. render-state.ts applies simple
	// line-level colors with the renderer callback's current theme instead.
	return lines.map((line) => line.separator
		? `${indent}     ...`
		: `${indent}${line.marker}${String(line.lineNumber).padStart(numberWidth, " ")} ${line.text}`);
}

function normalizePatchLine(rawLine: string): PreviewLine {
	const normalized = rawLine === "" ? " " : rawLine;
	const marker = normalized[0]!;
	if (marker !== " " && marker !== "+" && marker !== "-") {
		return { lineNumber: 0, marker: " ", text: rawLine };
	}
	return { lineNumber: 0, marker, text: normalized.slice(1) };
}

function findMatchingSequence(lines: string[], context: string[], start: number): number {
	if (context.length === 0) {
		return start;
	}

	const exact = findSequence(lines, context, start, (value) => value);
	if (exact !== -1) {
		return exact;
	}

	const trimEnd = findSequence(lines, context, start, (value) => value.trimEnd());
	if (trimEnd !== -1) {
		return trimEnd;
	}

	const trim = findSequence(lines, context, start, (value) => value.trim());
	if (trim !== -1) {
		return trim;
	}

	return -1;
}

function findSequence(lines: string[], context: string[], start: number, normalize: (value: string) => string): number {
	for (let lineIndex = start; lineIndex <= lines.length - context.length; lineIndex += 1) {
		let matches = true;
		for (let contextIndex = 0; contextIndex < context.length; contextIndex += 1) {
			if (normalize((lines[lineIndex + contextIndex])!) !== normalize(context[contextIndex]!)) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return lineIndex;
		}
	}
	return -1;
}

export function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string {
	const from = displayPath(path, cwd);
	if (!movePath) {
		return from;
	}
	return `${from} → ${displayPath(movePath, cwd)}`;
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) {
		return path;
	}

	const relativePath = relative(cwd, path);
	if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return relativePath;
	}

	return path;
}

function readFileLines(path: string, cwd: string): string[] {
	try {
		return splitFileLines(openFileAtPath({ cwd, path }));
	} catch {
		return [];
	}
}

function splitFileLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	// File reads preserve CRLF. A stray carriage return inside a rendered TUI
	// row sends the terminal cursor back to column zero before Box writes its
	// padding, leaving the right side of the row unpainted. Normalize line
	// endings at the semantic preview boundary so no component ever sees CR.
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

function bulletHeader(verb: string, label: string): string {
	return `• ${verb} ${label}`;
}

function renderCounts(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}
