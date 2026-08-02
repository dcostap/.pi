import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSubagentProfiles, parseProfileMarkdown } from "./profiles.ts";

describe("subagent profiles", () => {
	test("parses metadata, coordinator guidance, and prompt body", () => {
		const profile = parseProfileMarkdown(`---
name: review
description: Read-only reviewer
id-prefix: review
coordinator-guidelines: ["Launch together", "Wait once"]
---
# Instructions

Do not edit.
`, "review.md");
		expect(profile.name).toBe("review");
		expect(profile.idPrefix).toBe("review");
		expect(profile.coordinatorGuidelines).toEqual(["Launch together", "Wait once"]);
		expect(profile.prompt).toContain("Do not edit.");
	});

	test("rejects unknown metadata instead of silently ignoring it", () => {
		expect(() => parseProfileMarkdown(`---
name: review
description: Reviewer
unexpected: true
---
Prompt
`, "review.md")).toThrow("unknown frontmatter key unexpected");
	});

	test("discovers the external review profile", async () => {
		const profiles = await loadSubagentProfiles(path.join(path.dirname(fileURLToPath(import.meta.url)), "profiles"));
		const review = profiles.get("review");
		expect(review?.idPrefix).toBe("review");
		expect(review?.prompt).toContain("# Review Guidelines");
		expect(review?.coordinatorGuidelines.some((line) => line.includes("subagent_wait"))).toBe(true);
	});
});
