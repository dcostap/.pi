import { describe, expect, test } from "bun:test";
import { sanitizeTerminalText } from "./sanitize.ts";

describe("sanitizeTerminalText", () => {
	const cases: Array<[string, string]> = [
		["safe\x1b[31mRED\x1b[0mend", "safeREDend"],
		["left\x1b]0;SECRET\x07right", "leftright"],
		["a\x1b]8;;https://evil.invalid\x1b\\link\x1b]8;;\x1b\\b", "alinkb"],
		["a\x1bP1;2;3+qSECRET\x1b\\b", "ab"],
		["a\x1b_SECRET\x1b\\b", "ab"],
		["a\x1b^SECRET\x1b\\b", "ab"],
		["a\x1bXSECRET\x1b\\b", "ab"],
		[`a\u009b999Db`, "ab"],
		[`a\u009d0;SECRET\u009cb`, "ab"],
		["visible\x1b]0;HIDDEN", "visible"],
		["a\x00\x08\tb\r\nc", "a  b\nc"],
		["a\x1b(0b", "ab"],
	];

	for (const [input, expected] of cases) {
		test(JSON.stringify(input), () => expect(sanitizeTerminalText(input)).toBe(expected));
	}

	test("randomized terminal payloads leave no unsafe controls", () => {
		const attacks = [
			"\x1b]0;OSC_PAYLOAD\x07",
			"\x1b]8;;https://evil.invalid\x1b\\OSC_LINK\x1b]8;;\x1b\\",
			"\x1bP1;2|DCS_PAYLOAD\x1b\\",
			"\x1b_APC_PAYLOAD\x1b\\",
			"\x1b^PM_PAYLOAD\x1b\\",
			"\x1b[999;999H",
			"\u009dC1_OSC\u009c",
		];
		for (let i = 0; i < 20_000; i++) {
			const output = sanitizeTerminalText(`safe${attacks[i % attacks.length]}text${String.fromCharCode(i % 32)}`);
			expect(output).not.toMatch(/[\u001b\u007f-\u009f\u0000-\u0008\u000b-\u001f]/);
			expect(output).not.toContain("PAYLOAD");
			expect(output).not.toContain("evil.invalid");
		}
	});
});
