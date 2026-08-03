import { describe, expect, test } from "bun:test";
import { buildMainInstructions, combinedSystemPrompt, genericPrompt, MAX_BATCH_MEMBERS, parseStartRequest } from "./launch-contract.ts";
import type { SubagentRole } from "./roles.ts";

const reviewRole: SubagentRole = {
	name: "review",
	description: "Independent read-only code review.",
	prompt: "Follow the review rubric.",
	filePath: "review.md",
};

describe("subagent launch requests", () => {
	test("resolves a formal batch and inherits its optional role", () => {
		const request = parseStartRequest({
			batch: {
				title: "Review batch",
				shared_prompt: "Review the current diff.",
				role: "review",
				agents: [
					{ title: "Correctness", task: "Focus on lifecycle.", model: "p/m", thinking: "high" },
					{ title: "UX", task: "Focus on UX.", model: "p/m", thinking: "high", role: "other" },
				],
			},
		}, "tool input");

		expect(request.batch?.shared_prompt).toBe("Review the current diff.");
		expect(request.specs.map((spec) => spec.role)).toEqual(["review", "other"]);
	});

	test("requires a non-empty shared prompt for formal batches", () => {
		expect(() => parseStartRequest({
			batch: {
				title: "Batch",
				shared_prompt: "",
				agents: [{ title: "One", task: "Task", model: "p/m", thinking: "high" }],
			},
		}, "tool input")).toThrow("shared_prompt: required non-empty string");
	});

	test("translates legacy profile fields without exposing them in the new request", () => {
		const request = parseStartRequest({
			title: "Legacy reviewer",
			task: "Review",
			model: "p/m",
			thinking: "high",
			profile: "review",
		}, "manifest");
		expect(request.specs[0]?.role).toBe("review");
		expect(request.specs[0]).not.toHaveProperty("profile");
	});

	test("rejects malformed legacy profile values instead of silently dropping them", () => {
		expect(() => parseStartRequest({
			title: "Malformed legacy request",
			task: "Review",
			model: "p/m",
			thinking: "high",
			profile: 42,
		}, "manifest")).toThrow("profile: unknown property");
	});

	test("bounds formal batch fan-out", () => {
		expect(() => parseStartRequest({
			batch: {
				title: "Too many",
				shared_prompt: "Shared",
				agents: Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, index) => ({ title: `Agent ${index}`, task: "Task", model: "p/m", thinking: "high" })),
			},
		}, "tool input")).toThrow(`exceeds maximum of ${MAX_BATCH_MEMBERS}`);
	});

	test("keeps shared and individual assignments distinct", () => {
		const prompt = genericPrompt("Individual focus", "C:/scratch", undefined, "Shared target");
		expect(prompt).toContain("<shared_assignment>\nShared target\n</shared_assignment>");
		expect(prompt).toContain("<individual_task>\nIndividual focus\n</individual_task>");
		expect(prompt).not.toContain("subagent_role");
	});

	test("places role instructions in the child system prompt", async () => {
		const prompt = await combinedSystemPrompt({
			title: "Review",
			task: "Review it",
			model: "p/m",
			thinking: "high",
			role: "review",
		}, reviewRole, process.cwd());
		expect(prompt?.toString("utf8")).toBe('<subagent_role name="review">\nFollow the review rubric.\n</subagent_role>');
	});

	test("injects the concise role catalog and selection rule", () => {
		const instructions = buildMainInstructions(new Map([[reviewRole.name, reviewRole]]));
		expect(instructions).toContain("Available roles:\n- review: Independent read-only code review.");
		expect(instructions).toContain('When the user requests "<role> subagents", use that role for each launched subagent.');
		expect(instructions).not.toContain("For example, \"launch 3 review subagents\"");
	});
});
