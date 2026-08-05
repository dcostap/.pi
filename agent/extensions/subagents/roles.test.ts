import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSubagentRoles, parseRoleMarkdown } from "./roles.ts";

describe("subagent roles", () => {
	test("parses metadata and the system-prompt body", () => {
		const role = parseRoleMarkdown(`---
name: review
description: Read-only reviewer
---
# Instructions

Do not edit.
`, "review.md");
		expect(role.name).toBe("review");
		expect(role.description).toBe("Read-only reviewer");
		expect(role.prompt).toContain("Do not edit.");
	});

	test("rejects unknown metadata instead of silently ignoring it", () => {
		expect(() => parseRoleMarkdown(`---
name: review
description: Reviewer
unexpected: true
---
Prompt
`, "review.md")).toThrow("unknown frontmatter key unexpected");
	});

	test("discovers the external review roles", async () => {
		const roles = await loadSubagentRoles(path.join(path.dirname(fileURLToPath(import.meta.url)), "roles"));
		const review = roles.get("code-review");
		expect(review?.description).toContain("read-only code review");
		expect(review?.prompt).toContain("# Review Guidelines");
		const simplifier = roles.get("code-simplifier");
		expect(simplifier?.description).toContain("simplification review");
		expect(simplifier?.prompt).toContain("# Code Simplification Review Guidelines");
	});

	test("loads unique legacy profile files as role aliases while preferring migrated roles", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-subagent-roles-"));
		const roleDir = path.join(root, "roles");
		const profileDir = path.join(root, "profiles");
		await Promise.all([mkdir(roleDir), mkdir(profileDir)]);
		await writeFile(path.join(roleDir, "review.md"), `---\nname: review\ndescription: New review role\n---\nNew prompt\n`);
		await writeFile(path.join(profileDir, "legacy.md"), `---\nname: legacy\ndescription: Legacy custom profile\nid-prefix: custom\ncoordinator-guidelines: ["old guidance"]\n---\nLegacy prompt\n`);
		await writeFile(path.join(profileDir, "review.md"), `---\nname: review\ndescription: Old review profile\nid-prefix: review\n---\nOld prompt\n`);
		try {
			const roles = await loadSubagentRoles(roleDir, profileDir);
			expect(roles.get("legacy")?.prompt).toBe("Legacy prompt");
			expect(roles.get("review")?.prompt).toBe("New prompt");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
