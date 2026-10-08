import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES } from "../_shared/spinner.ts";
import { segmentTheme, widgetSegments } from "./widget-segments.ts";

const { fg, bold } = segmentTheme;

describe("widget segments", () => {
	test("turns theme colors and bold back into segments", () => {
		const line = fg("toolTitle", bold("Subagents")) + fg("muted", " · 1 active");
		expect(widgetSegments(line)).toEqual([
			{ text: "Subagents", color: "toolTitle", bold: true },
			{ text: " · 1 active", color: "muted" },
		]);
	});

	test("keeps plain text and merges equal neighbours", () => {
		expect(widgetSegments(`a${fg("dim", "b")}${fg("dim", "c")}d`)).toEqual([
			{ text: "a" },
			{ text: "bc", color: "dim" },
			{ text: "d" },
		]);
	});

	test("marks the spinner frame of a running agent", () => {
		const frame = SPINNER_FRAMES[2]!;
		expect(widgetSegments(fg("accent", `${frame} running`))).toEqual([
			{ text: frame, color: "accent", spinner: true },
			{ text: " running", color: "accent" },
		]);
		expect(widgetSegments(fg("success", "✓ completed"))).toEqual([{ text: "✓ completed", color: "success" }]);
	});

	test("a reset ends the style and other escape codes are dropped", () => {
		// The TUI truncation ends a cut line with a reset and an ellipsis.
		const line = `${fg("accent", bold("abc"))}\x1b[0m…\x1b]8;;https://x\x07d`;
		expect(widgetSegments(line)).toEqual([
			{ text: "abc", color: "accent", bold: true },
			{ text: "…d" },
		]);
	});
});
