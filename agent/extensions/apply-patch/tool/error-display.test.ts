import { describe, expect, test } from "bun:test";
import { conciseApplyPatchFailureReason } from "./error-display.ts";

describe("apply_patch error display", () => {
	test("summarizes expected-line failures without exposing the code dump", () => {
		const raw = [
			"Failed to find expected lines in C:\\work\\src\\panel.kt:",
			"private class PaintProfiler {",
			"    override fun paint() = Unit",
			"}",
		].join("\n");

		const reason = conciseApplyPatchFailureReason(raw);

		expect(reason).toBe("Expected lines no longer matched the target file.");
		expect(reason).not.toContain("PaintProfiler");
	});

	test("uses the failed target for partial patches", () => {
		const reason = conciseApplyPatchFailureReason(
			"Failed to find context in C:\\work\\index.ts:\nconst stale = true;",
			"index.ts",
		);

		expect(reason).toBe("Expected lines no longer matched in index.ts.");
	});

	test("keeps an unknown failure to one bounded diagnostic line", () => {
		const raw = `Error: ${"Could not acquire the file lock. ".repeat(20)}\ninternal stack details`;
		const reason = conciseApplyPatchFailureReason(raw);

		expect(reason).not.toContain("internal stack details");
		expect(reason.length).toBeLessThanOrEqual(180);
		expect(reason.endsWith("…")).toBe(true);
	});
});
