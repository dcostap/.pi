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
		const text = formatParentUpdates(updates);
		expect(text.indexOf("## Report — One")).toBeLessThan(text.indexOf("## Completion — Title sa-two"));
		expect(text).toContain("Final answer");
		expect(text).not.toContain("Tokens:");
		expect(text).not.toContain("Exact cost");
		expect(text).not.toContain("Session:");
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
