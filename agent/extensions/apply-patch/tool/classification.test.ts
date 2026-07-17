import { describe, expect, test } from "bun:test";
import type { ExecutePatchResult, ParsedPatchAction } from "../patch/types.ts";
import { classifyActions, formatPartialProgress } from "./classification.ts";

const partialResult: ExecutePatchResult = {
	changedFiles: ["same.txt"],
	createdFiles: [],
	deletedFiles: [],
	movedFiles: [],
	fuzz: 0,
};

describe("apply_patch action classification", () => {
	test("describes repeated targets as changes rather than files", () => {
		expect(formatPartialProgress(["same.txt", "same.txt"], 1)).toBe("1 of 2 changes applied");
		expect(formatPartialProgress(["one.txt", "two.txt"], 1)).toBe("1 of 2 files changed");
	});

	test("uses ordered deltas to distinguish repeated-path actions", () => {
		const actions: ParsedPatchAction[] = [
			{ type: "update", path: "same.txt", lines: ["@@", "-old", "+middle"] },
			{ type: "update", path: "same.txt", lines: ["@@", "-missing", "+new"] },
		];

		expect(classifyActions(actions, partialResult, "C:/work", [
			{ kind: "update", path: "same.txt", movePath: null },
		])).toEqual({
			attemptedFiles: ["same.txt", "same.txt"],
			appliedFiles: ["same.txt"],
			failedFiles: ["same.txt"],
			failedActionIndexes: [1],
		});
	});

	test("retains the path-based fallback for historical results", () => {
		const actions: ParsedPatchAction[] = [
			{ type: "update", path: "same.txt", lines: ["@@", "-old", "+new"] },
		];

		expect(classifyActions(actions, partialResult, "C:/work").failedActionIndexes).toEqual([]);
	});
});
