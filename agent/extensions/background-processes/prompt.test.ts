import { describe, expect, test } from "bun:test";
import {
	BACKGROUND_NOTICE_MARKER,
	BACKGROUND_PROCESS_PROMPT,
	backgroundNotice,
	bashToolDescription,
	normalizeTitle,
	stripBackgroundNotice,
	titleFromCommand,
	withBackgroundNotice,
} from "./prompt.ts";

describe("background process prompt", () => {
	test("warns against interaction, polling, and nested backgrounding", () => {
		expect(BACKGROUND_PROCESS_PROMPT).toContain("bash_bg_start");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("bash_bg_wait");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("instead of polling");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("interrupted wait leaves the process running");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("receive no stdin");
		expect(BACKGROUND_PROCESS_PROMPT).toContain("Do not append &");
	});

	test("the bash description replaces the built-in timeout sentence", () => {
		const description = bashToolDescription("Execute a bash command. Optionally provide a timeout in seconds.");
		expect(description).not.toContain("Optionally provide a timeout");
		expect(description).toContain("capped at 480 seconds");
		expect(description).toContain("NOT killed");
	});

	test("normalizes titles to one line and 80 code points", () => {
		expect(normalizeTitle("  dev\n  server  ")).toBe("dev server");
		expect([...normalizeTitle("😀".repeat(100))]).toHaveLength(80);
	});

	test("derives a title from the first command line", () => {
		expect(titleFromCommand("\n  cd app &&   bun test\nmore")).toBe("cd app && bun test");
		expect([...titleFromCommand("x".repeat(200))]).toHaveLength(80);
		expect(titleFromCommand("x".repeat(200))).toEndWith("…");
	});
});

describe("background notices", () => {
	test("every cause says the process still runs and how to continue", () => {
		const causes = [
			{ kind: "bash-timeout", id: "bg-1", seconds: 480 },
			{ kind: "bash-steer", id: "bg-1" },
			{ kind: "wait-timeout", ids: ["bg-1", "bg-2"], seconds: 60 },
			{ kind: "wait-steer", ids: ["bg-1"] },
		] as const;
		for (const cause of causes) {
			const notice = backgroundNotice(cause);
			expect(notice).toStartWith(BACKGROUND_NOTICE_MARKER);
			expect(notice).toContain("bash_bg_wait with ids");
			expect(notice).toContain("end your turn");
			expect(notice).toContain("woken up");
			expect(notice).toContain("bash_bg_kill");
		}
		expect(backgroundNotice(causes[0])).toContain("did not finish within 480s, so it was moved to the background as bg-1");
		expect(backgroundNotice(causes[1])).toContain("address the user's message first");
		expect(backgroundNotice(causes[2])).toContain('bg-1, bg-2 are still running');
	});

	test("renderers can strip the notice again", () => {
		const text = withBackgroundNotice("output\n", { kind: "bash-steer", id: "bg-3" });
		expect(stripBackgroundNotice(text)).toBe("output");
		expect(stripBackgroundNotice("plain")).toBe("plain");
	});
});
