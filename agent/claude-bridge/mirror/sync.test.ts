import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mirrorSessionId, sessionFolderName, syncTranscript } from "./sync.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
let root: string;
let transcript: string;
let sessionsDir: string;

const row = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const userRow = (uuid: string, parentUuid: string | null, content: string, second: number) => row({
	type: "user", uuid, parentUuid, isSidechain: false, cwd: "C:\\Work\\demo", sessionId: SESSION,
	timestamp: `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`, message: { role: "user", content },
});
const assistantRow = (uuid: string, parentUuid: string, text: string, second: number) => row({
	type: "assistant", uuid, parentUuid, isSidechain: false, cwd: "C:\\Work\\demo", sessionId: SESSION,
	timestamp: `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`,
	message: { id: `msg-${uuid}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} },
});

async function mirrorFiles(): Promise<string[]> {
	const folder = path.join(sessionsDir, sessionFolderName("C:\\Work\\demo"));
	return (await readdir(folder)).sort();
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "cc-mirror-test-"));
	sessionsDir = path.join(root, "sessions");
	transcript = path.join(root, `${SESSION}.jsonl`);
	await writeFile(transcript, userRow("u1", null, "hello", 1) + assistantRow("a1", "u1", "hi", 2) + row({ type: "ai-title", aiTitle: "Demo" }));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("syncTranscript", () => {
	test("uses Pi's folder name rule", () => {
		expect(sessionFolderName("C:\\Users\\Dario Costa\\.pi")).toBe("--C--Users-Dario Costa-.pi--");
		expect(sessionFolderName("/home/me/x")).toBe("--home-me-x--");
	});

	test("writes, then reports unchanged, then rewrites when the transcript grows", async () => {
		const first = await syncTranscript(transcript, { sessionsDir });
		expect(first.status).toBe("written");
		expect(path.basename(first.file!)).toBe(`2026-10-01T10-00-01-000Z_${SESSION}.jsonl`);
		expect((await syncTranscript(transcript, { sessionsDir })).status).toBe("unchanged");
		await appendFile(transcript, userRow("u2", "a1", "more", 3));
		const third = await syncTranscript(transcript, { sessionsDir });
		expect(third).toEqual({ status: "written", file: first.file });
		expect(await readFile(first.file!, "utf8")).toContain("\"more\"");
		expect(await mirrorFiles()).toHaveLength(1);
	});

	test("ignores metadata Pi appends after the marker", async () => {
		const first = await syncTranscript(transcript, { sessionsDir });
		await appendFile(first.file!, row({ type: "model_change", id: "abcd1234", parentId: "x", timestamp: "2026-10-01T11:00:00.000Z", provider: "openai", modelId: "gpt" }));
		await appendFile(transcript, userRow("u2", "a1", "more", 3));
		expect((await syncTranscript(transcript, { sessionsDir })).file).toBe(first.file);
		expect(await mirrorFiles()).toHaveLength(1);
	});

	test("freezes a mirror continued in Pi and writes the next one", async () => {
		const first = await syncTranscript(transcript, { sessionsDir });
		await appendFile(first.file!, row({ type: "message", id: "abcd1234", parentId: "x", timestamp: "2026-10-01T11:00:00.000Z", message: { role: "user", content: "pi turn", timestamp: 0 } }));
		const frozenContent = await readFile(first.file!, "utf8");
		await appendFile(transcript, userRow("u2", "a1", "more", 3));
		const second = await syncTranscript(transcript, { sessionsDir });
		expect(second.status).toBe("written");
		expect(second.file).not.toBe(first.file);
		expect(second.file).toContain(mirrorSessionId(SESSION, 1));
		expect(await readFile(first.file!, "utf8")).toBe(frozenContent);
		const secondContent = await readFile(second.file!, "utf8");
		expect(secondContent).toContain("[Claude] Demo (2)");
		expect(JSON.parse(secondContent.split("\n")[0]!).id).toBe(mirrorSessionId(SESSION, 1));
		expect((await syncTranscript(transcript, { sessionsDir })).status).toBe("unchanged");
		expect(await mirrorFiles()).toHaveLength(2);
	});

	test("mirror IDs are stable UUIDs", () => {
		expect(mirrorSessionId(SESSION, 0)).toBe(SESSION);
		expect(mirrorSessionId(SESSION, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(mirrorSessionId(SESSION, 1)).toBe(mirrorSessionId(SESSION, 1));
	});
});
