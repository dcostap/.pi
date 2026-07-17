import { describe, expect, test } from "bun:test";
import { BACKGROUND_PROCESS_PROMPT, normalizeTitle } from "./prompt.ts";

describe("background process prompt", () => {
	test("warns against interaction, polling, and nested backgrounding", () => {
		expect(BACKGROUND_PROCESS_PROMPT).toContain("bash_bg_start");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("bash_bg_wait");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("instead of polling");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("receive no stdin");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("Do not append &");
	});

	test("normalizes titles to one line and 80 code points", () => {
		expect(normalizeTitle("  dev\n  server  ")).toBe("dev server");
		expect([...normalizeTitle("😀".repeat(100))]).toHaveLength(80);
	});
});
