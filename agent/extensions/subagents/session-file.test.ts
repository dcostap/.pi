import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeSessionFile } from "./session-file.ts";

describe("subagent session files", () => {
	test("materializes the parent header before a child process opens the path", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-subagent-session-"));

		try {
			const sessionFile = path.join(directory, "child.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "child",
				timestamp: new Date().toISOString(),
				cwd: directory,
				parentSession: path.join(directory, "parent.jsonl"),
			};
			const entry = {
				type: "session_info",
				id: "entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "Subagent",
			};

			const source = {
				getSessionFile: () => sessionFile,
				getHeader: () => header,
				getEntries: () => [entry],
			};

			expect(await materializeSessionFile(source)).toBe(sessionFile);
			const lines = (await readFile(sessionFile, "utf8")).trim().split("\n");
			expect(JSON.parse(lines[0]!).parentSession).toBe(header.parentSession);
			expect(JSON.parse(lines[1]!)).toEqual(entry);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
