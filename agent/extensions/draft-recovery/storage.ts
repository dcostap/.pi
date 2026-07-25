import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const DRAFT_VERSION = 1;

export interface DraftRecord {
	version: typeof DRAFT_VERSION;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	updatedAt: number;
	text: string;
}

export interface QueuedDraftWrite {
	generation: number;
	record: DraftRecord | null;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function unlinkIfPresent(path: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await unlink(path);
			return;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			if (!isTransientWindowsFileError(error) || attempt >= 6) throw error;
			await delay(10 * 2 ** attempt);
		}
	}
}

const TRANSIENT_WINDOWS_FILE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

function isTransientWindowsFileError(error: unknown): boolean {
	return process.platform === "win32" && TRANSIENT_WINDOWS_FILE_ERRORS.has(errorCode(error) ?? "");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function renameWithRetry(oldPath: string, newPath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(oldPath, newPath);
			return;
		} catch (error) {
			if (!isTransientWindowsFileError(error) || attempt >= 6) throw error;
			await delay(10 * 2 ** attempt);
		}
	}
}

function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function draftPath(draftDir: string, sessionId: string): string {
	return join(draftDir, `session-${safeSessionId(sessionId)}.json`);
}

export function isDraftRecord(value: unknown): value is DraftRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<DraftRecord>;
	return (
		record.version === DRAFT_VERSION &&
		typeof record.sessionId === "string" &&
		typeof record.sessionFile === "string" &&
		typeof record.cwd === "string" &&
		typeof record.updatedAt === "number" &&
		Number.isFinite(record.updatedAt) &&
		typeof record.text === "string"
	);
}

async function parseDraft(path: string): Promise<DraftRecord | undefined> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	try {
		const parsed: unknown = JSON.parse(contents);
		return isDraftRecord(parsed) ? parsed : undefined;
	} catch {
		// A malformed primary can still fall back to a valid .bak.
		return undefined;
	}
}

function transactionBackupPrefix(path: string): string {
	return `${basename(path)}.`;
}

async function backupPaths(path: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dirname(path));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}

	const fileName = basename(path);
	const prefix = transactionBackupPrefix(path);
	return names
		.filter((name) => name === `${fileName}.bak` || (name.startsWith(prefix) && name.endsWith(".bak")))
		.map((name) => join(dirname(path), name));
}

async function parseDraftWithBackups(path: string): Promise<DraftRecord | undefined> {
	const primary = await parseDraft(path);
	if (primary) return primary;

	const backups = await backupPaths(path);
	const records = await Promise.all(backups.map((backup) => parseDraft(backup)));
	return records
		.filter((record): record is DraftRecord => record !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Read the current draft, falling back to the last atomic-write backup. */
export async function readDraft(draftDir: string, sessionId: string): Promise<DraftRecord | undefined> {
	const path = draftPath(draftDir, sessionId);
	return parseDraftWithBackups(path);
}

/**
 * Replace a file without exposing a partially-written JSON document. The old
 * file is retained as a unique backup across the rename window. Unique backup
 * names avoid contention with stale/locked .bak files on Windows. Cleanup
 * after a successful commit is best effort because failure to remove a backup
 * must never turn a successful draft save into an error.
 */
async function atomicWrite(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const transactionId = `${process.pid}.${randomUUID()}`;
	const temporaryPath = `${path}.${transactionId}.tmp`;
	const backupPath = `${path}.${transactionId}.bak`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let movedPreviousFile = false;

	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(contents, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;

		try {
			await renameWithRetry(path, backupPath);
			movedPreviousFile = true;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}

		try {
			await renameWithRetry(temporaryPath, path);
		} catch (error) {
			// Best effort rollback if the second rename fails.
			if (movedPreviousFile) {
				try {
					await renameWithRetry(backupPath, path);
				} catch {
					// The transaction backup remains readable if rollback is not possible.
				}
			}
			throw error;
		}

		if (movedPreviousFile) await unlinkIfPresent(backupPath).catch(() => undefined);
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		await unlinkIfPresent(temporaryPath).catch(() => undefined);
	}
}

export async function writeDraft(draftDir: string, record: DraftRecord): Promise<void> {
	await atomicWrite(draftPath(draftDir, record.sessionId), `${JSON.stringify(record)}\n`);
}

export async function deleteDraft(draftDir: string, sessionId: string): Promise<void> {
	const path = draftPath(draftDir, sessionId);
	await Promise.all([unlinkIfPresent(path), ...(await backupPaths(path)).map((backup) => unlinkIfPresent(backup))]);
}

/** Keep a conflicting recovered draft before replacing the current slot. */
export async function archiveDraft(draftDir: string, record: DraftRecord): Promise<void> {
	const archivePath = join(
		draftDir,
		`archive-${safeSessionId(record.sessionId)}-${record.updatedAt}-${randomUUID().slice(0, 8)}.json`,
	);
	await atomicWrite(archivePath, `${JSON.stringify(record)}\n`);
}

export async function listDrafts(draftDir: string): Promise<DraftRecord[]> {
	let names: string[];
	try {
		names = await readdir(draftDir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}

	const candidates = new Set<string>();
	for (const name of names) {
		if (name.endsWith(".json")) candidates.add(join(draftDir, name));
		else if (name.endsWith(".json.bak")) candidates.add(join(draftDir, name.slice(0, -4)));
		else {
			const marker = name.indexOf(".json.");
			if (marker >= 0 && name.endsWith(".bak")) candidates.add(join(draftDir, name.slice(0, marker + 5)));
		}
	}

	const records = await Promise.all([...candidates].map((path) => parseDraftWithBackups(path)));
	return records.filter((record): record is DraftRecord => record !== undefined && record.text.length > 0)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function pruneDrafts(draftDir: string, olderThan: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(draftDir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}

	await Promise.all(
		names.map(async (name) => {
			const path = join(draftDir, name);
			if (name.endsWith(".tmp")) {
				try {
					if ((await stat(path)).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await unlinkIfPresent(path);
				} catch {
					// Cleanup is best effort.
				}
				return;
			}
		}),
	);

	const candidates = new Set<string>();
	for (const name of names) {
		if (name.endsWith(".json")) candidates.add(join(draftDir, name));
		else if (name.endsWith(".json.bak")) candidates.add(join(draftDir, name.slice(0, -4)));
		else {
			const marker = name.indexOf(".json.");
			if (marker >= 0 && name.endsWith(".bak")) candidates.add(join(draftDir, name.slice(0, marker + 5)));
		}
	}

	await Promise.all(
		[...candidates].map(async (path) => {
			const record = await parseDraftWithBackups(path);
			if (record && record.updatedAt < olderThan) {
				await Promise.all([unlinkIfPresent(path), ...(await backupPaths(path)).map((backup) => unlinkIfPresent(backup))]);
			}
		}),
	);
}

/** Serializes disk writes and coalesces queued updates to the newest value. */
export class DraftWritePump {
	private pending: QueuedDraftWrite | undefined;
	private running: Promise<void> | undefined;

	constructor(
		private readonly persist: (write: QueuedDraftWrite) => Promise<void>,
		private readonly onSuccess: (write: QueuedDraftWrite) => void,
		private readonly onError: (write: QueuedDraftWrite, error: unknown) => void,
	) {}

	request(write: QueuedDraftWrite): void {
		this.pending = write;
		this.ensureRunning();
	}

	async flush(): Promise<void> {
		while (this.pending || this.running) {
			this.ensureRunning();
			if (this.running) await this.running;
		}
	}

	private ensureRunning(): void {
		if (this.running || !this.pending) return;
		this.running = this.drain().finally(() => {
			this.running = undefined;
			this.ensureRunning();
		});
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const write = this.pending;
			this.pending = undefined;
			try {
				await this.persist(write);
				this.onSuccess(write);
			} catch (error) {
				this.onError(write, error);
			}
		}
	}
}
