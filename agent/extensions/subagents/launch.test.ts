import { describe, expect, test } from "bun:test";
import { buildMainInstructions, combinedSystemPrompt, genericPrompt, parseStartRequest } from "./launch-contract.ts";
import type { SubagentRole } from "./roles.ts";

const reviewRole: SubagentRole = {
	name: "review",
	description: "Independent read-only code review.",
	prompt: "Follow the review rubric.",
	filePath: "review.md",
};

describe("subagent launch requests", () => {
	test("resolves a formal batch and inherits its optional role and context-file setting", () => {
		const request = parseStartRequest({
			batch: {
				title: "Review batch",
				shared_prompt: "Review the current diff.",
				role: "review",
				context_files: false,
				agents: [
					{ title: "Correctness", task: "Focus on lifecycle.", model: "p/m", thinking: "high" },
					{ title: "UX", task: "Focus on UX.", model: "p/m", thinking: "high", role: "other", context_files: true },
				],
			},
		}, "tool input");

		expect(request.batch?.shared_prompt).toBe("Review the current diff.");
		expect(request.specs.map((spec) => spec.role)).toEqual(["review", "other"]);
		expect(request.specs.map((spec) => spec.context_files)).toEqual([false, true]);
	});

	test("validates the context-file setting", () => {
		expect(() => parseStartRequest({
			title: "Review",
			task: "Review",
			model: "p/m",
			thinking: "high",
			context_files: "no",
		}, "tool input")).toThrow("context_files: expected boolean");
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

	test("allows large formal batch fan-out", () => {
		const request = parseStartRequest({
			batch: {
				title: "Large batch",
				shared_prompt: "Shared",
				agents: Array.from({ length: 40 }, (_, index) => ({ title: `Agent ${index}`, task: "Task", model: "p/m", thinking: "high" })),
			},
		}, "tool input");
		expect(request.specs).toHaveLength(40);
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
		expect(instructions).toContain("Never start Pi through bash as a substitute for subagent_start.");
		expect(instructions).toContain('When the user requests "<role> subagents", use that role for each launched subagent.');
		expect(instructions).not.toContain("For example, \"launch 3 review subagents\"");
	});

	test("limits parent reports to mid-task messages", () => {
		const instructions = buildMainInstructions(new Map(), true);
		expect(instructions).toContain("Use subagent_report only for mid-task messages");
		expect(instructions).toContain("A report ends a parent wait that includes you.");
		expect(instructions).toContain("Do not use it to report task or work completion.");
		expect(instructions).toContain("Do not use it for final reports.");
		expect(instructions).toContain("Pi sends your final answer to the parent automatically when you stop.");
	});
});
