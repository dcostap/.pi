import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-tool-feedback-"));
let agentDir = root;
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir,
	withFileMutationQueue: (_path: string, operation: () => Promise<void>) => operation(),
}));
const schema = () => ({});
mock.module("@earendil-works/pi-ai", () => ({
	Type: { Object: schema, String: schema, Optional: schema },
}));
const { default: register } = await import("./index");
let tool: any;
register({ registerTool: (value: unknown) => { tool = value; } } as any);
const ctx = {
	sessionManager: { getSessionId: () => "test-session" },
	model: { provider: "test", id: "model" },
};
afterAll(() => rm(root, { recursive: true, force: true }));

test("appends separate records with metadata and no session contents", async () => {
	const params = { tool: "read", problem: "First line\nSecond line", impact: "Required another call." };
	for (let i = 0; i < 2; i++) {
		const result = await tool.execute("test", params, undefined, undefined, ctx);
		expect(result.content[0].text).toBe("Feedback saved.");
	}
	const lines = (await readFile(join(root, "feedback/events.jsonl"), "utf8")).trim().split("\n");
	expect(lines).toHaveLength(2);
	for (const line of lines) {
		expect(JSON.parse(line)).toEqual({ ...params, sessionId: "test-session", model: "test/model", timestamp: expect.any(String) });
	}
});

test("storage failure does not throw or request a retry", async () => {
	agentDir = join(root, "not-a-directory");
	await writeFile(agentDir, "test");
	const result = await tool.execute("test", { tool: "read", problem: "test", impact: "test" }, undefined, undefined, ctx);
	expect(result.content[0].text).toBe("Feedback was not saved. Continue the task without retrying.");
});
