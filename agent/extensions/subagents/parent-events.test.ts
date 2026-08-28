import { describe, expect, test } from "bun:test";
import { formatParentUpdates, takeParentUpdateBatch, type ParentUpdate } from "./parent-events.ts";

function completion(id: string, outcome: "completed" | "failed" = "completed") {
	return {
		id,
		title: `Title ${id}`,
		outcome,
		model: "p/m",
		thinking: "high" as const,
		task: "Task",
		activity: "done",
		createdAt: 1,
		settledAt: 2,
		attempts: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, turns: 1 },
		finalAnswer: outcome === "completed" ? "Final answer" : "",
		error: outcome === "failed" ? "Failed safely" : undefined,
		sessionFile: "session.jsonl",
	};
}

describe("parent subagent updates", () => {
	test("keeps reports and completions in one ordered message", () => {
		const updates: ParentUpdate[] = [
			{ kind: "report", id: "sa-one", title: "One", runId: "sa-one-r1", createdAt: 1, message: "Need input." },
			{ kind: "completion", createdAt: 2, completion: completion("sa-two") },
		];
		const text = formatParentUpdates(updates, {
			agents: [
				{ id: "sa-one", title: "One", state: "running" },
				{ id: "sa-three", title: "Three", state: "parked" },
			],
		});
		expect(text.indexOf("## Mid-task report — One")).toBeLessThan(text.indexOf("## Managed subagent finished — Title sa-two"));
		expect(text).toContain("> Final result · sa-two · completed");
		expect(text).toContain("Final answer");
		expect(text).toContain("## Current managed activity");
		expect(text).toContain("2 direct subagents active · 1 running · 1 parked");
		expect(text).toContain("- sa-one · running · One");
		expect(text).not.toContain("Tokens:");
		expect(text).not.toContain("Exact cost");
		expect(text).not.toContain("Session:");
	});

	test("marks a lone completion as final and reports an empty live set", () => {
		const text = formatParentUpdates([
			{ kind: "completion", createdAt: 1, completion: completion("sa-done") },
		], { agents: [] });
		expect(text).toStartWith("# Managed subagent finished");
		expect(text).toContain("## Managed subagent finished — Title sa-done");
		expect(text).toContain("> Final result · sa-done · completed");
		expect(text).toContain("> 0 direct subagents active");
	});

	test("reserves delivery capacity for both reports and completions", () => {
		const pending: ParentUpdate[] = [
			...Array.from({ length: 8 }, (_, index): ParentUpdate => ({
				kind: "report", id: `sa-${index}`, title: String(index), createdAt: index, message: String(index),
			})),
			{ kind: "completion", createdAt: 8, completion: completion("sa-done") },
		];
		const selected = takeParentUpdateBatch(pending);
		expect(selected.filter((item) => item.kind === "report")).toHaveLength(3);
		expect(selected.some((item) => item.kind === "completion")).toBe(true);
		expect(pending.filter((item) => item.kind === "report")).toHaveLength(5);
	});
});
