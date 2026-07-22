import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteDraft,
	draftPath,
	DraftWritePump,
	listDrafts,
	pruneDrafts,
	readDraft,
	type DraftRecord,
	writeDraft,
} from "./storage";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-draft-recovery-"));
	temporaryDirectories.push(path);
	return path;
}

function record(text: string, sessionId = "session-1"): DraftRecord {
	return {
		version: 1,
		sessionId,
		sessionFile: `C:/sessions/${sessionId}.jsonl`,
		cwd: "C:/work",
		updatedAt: Date.now(),
		text,
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("draft storage", () => {
	test("round-trips and deletes a session draft", async () => {
		const dir = await temporaryDirectory();
		await writeDraft(dir, record("large unsent prompt"));
		expect((await readDraft(dir, "session-1"))?.text).toBe("large unsent prompt");
		await deleteDraft(dir, "session-1");
		expect(await readDraft(dir, "session-1")).toBeUndefined();
	});

	test("falls back to the backup after a torn replacement window", async () => {
		const dir = await temporaryDirectory();
		const original = record("safe copy");
		await mkdir(dir, { recursive: true });
		await writeFile(`${draftPath(dir, original.sessionId)}.bak`, JSON.stringify(original), "utf8");
		expect((await readDraft(dir, original.sessionId))?.text).toBe("safe copy");
	});

	test("ignores malformed records when listing", async () => {
		const dir = await temporaryDirectory();
		await writeDraft(dir, record("valid"));
		await writeFile(join(dir, "broken.json"), "not json", "utf8");
		expect((await listDrafts(dir)).map((draft) => draft.text)).toEqual(["valid"]);
	});

	test("prunes an expired backup-only draft", async () => {
		const dir = await temporaryDirectory();
		const expired = { ...record("expired"), updatedAt: 1 };
		await writeFile(`${draftPath(dir, expired.sessionId)}.bak`, JSON.stringify(expired), "utf8");
		await pruneDrafts(dir, 2);
		expect(await readDraft(dir, expired.sessionId)).toBeUndefined();
	});
});

describe("DraftWritePump", () => {
	test("serializes writes and keeps the latest queued update", async () => {
		const started: number[] = [];
		const completed: number[] = [];
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const pump = new DraftWritePump(
			async (write) => {
				started.push(write.generation);
				if (write.generation === 1) await firstBlocked;
				completed.push(write.generation);
			},
			() => undefined,
			() => undefined,
		);

		pump.request({ generation: 1, record: record("one") });
		pump.request({ generation: 2, record: record("two") });
		pump.request({ generation: 3, record: record("three") });
		releaseFirst();
		await pump.flush();

		expect(started).toEqual([1, 3]);
		expect(completed).toEqual([1, 3]);
	});
});
