import { describe, expect, test } from "bun:test";
import { withPreservedAnsiBackground } from "./ansi-background.ts";

const GREEN_BACKGROUND = "\u001b[48;2;40;50;40m";
const RESET_BACKGROUND = "\u001b[49m";

function green(value: string): string {
	return `${GREEN_BACKGROUND}${value}${RESET_BACKGROUND}`;
}

describe("ANSI background preservation", () => {
	test("restores the background after a full style reset", () => {
		const text = `left\u001b[0mright`;

		expect(withPreservedAnsiBackground(text, green)).toBe(
			`${GREEN_BACKGROUND}left\u001b[0m${GREEN_BACKGROUND}right${RESET_BACKGROUND}`,
		);
	});

	test("restores the background after a background-only reset", () => {
		const text = `left${RESET_BACKGROUND}right`;

		expect(withPreservedAnsiBackground(text, green)).toBe(
			`${GREEN_BACKGROUND}left${RESET_BACKGROUND}${GREEN_BACKGROUND}right${RESET_BACKGROUND}`,
		);
	});
});
