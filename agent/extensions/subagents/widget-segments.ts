// The pinned widget as styled text segments, for a client that draws its own
// UI (the Claude Code bridge band). The theme writes each Pi color as an
// indexed SGR code, so the usual width and truncation helpers still work on
// the lines; the parser turns the codes back into color names.
import { SPINNER_FRAMES } from "../_shared/spinner.ts";

export type WidgetSegment = { text: string; color?: string; bold?: true; spinner?: true };

const colorNames: string[] = [];

function colorIndex(color: string): number {
	const index = colorNames.indexOf(color);
	if (index >= 0) return index;
	colorNames.push(color);
	return colorNames.length - 1;
}

/** The subset of a Pi Theme that the widget lines call. */
export const segmentTheme = {
	fg: (color: string, text: string): string => `\x1b[38;5;${colorIndex(color)}m${text}\x1b[39m`,
	bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
};

// A running agent's state cell starts with a spinner frame. Mark it so the
// client animates it.
const spinnerPattern = new RegExp(`^([${SPINNER_FRAMES.join("")}]) (?=running|starting|stopping)`, "u");

function splitSpinner(segment: WidgetSegment): WidgetSegment[] {
	const match = spinnerPattern.exec(segment.text);
	if (!match) return [segment];
	return [{ ...segment, text: match[1]!, spinner: true }, { ...segment, text: segment.text.slice(match[1]!.length) }];
}

/** Parses one widget line written with segmentTheme. Other escape codes are dropped. */
export function widgetSegments(line: string): WidgetSegment[] {
	const segments: WidgetSegment[] = [];
	let color: string | undefined;
	let bold = false;
	const push = (text: string) => {
		if (!text) return;
		const previous = segments.at(-1);
		if (previous && previous.color === color && Boolean(previous.bold) === bold) {
			previous.text += text;
			return;
		}
		segments.push({ text, ...(color ? { color } : {}), ...(bold ? { bold: true as const } : {}) });
	};
	let last = 0;
	for (const match of line.matchAll(/\x1b\[([\d;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
		push(line.slice(last, match.index));
		last = match.index + match[0].length;
		if (match[1] === undefined) continue;
		const codes = match[1].split(";");
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index];
			if (code === "" || code === "0") {
				color = undefined;
				bold = false;
			} else if (code === "1") bold = true;
			else if (code === "22") bold = false;
			else if (code === "39") color = undefined;
			else if (code === "38" && codes[index + 1] === "5") {
				color = colorNames[Number(codes[index + 2])];
				index += 2;
			}
		}
	}
	push(line.slice(last));
	return segments.flatMap(splitSpinner);
}
