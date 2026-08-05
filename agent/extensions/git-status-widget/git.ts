import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILES_FOR_LINES = 100;
const MAX_UNTRACKED_BYTES_FOR_LINES = 5 * 1024 * 1024;
const UNTRACKED_READ_CONCURRENCY = 4;
const EMPTY_TREES = {
	sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

export type GitRunner = (
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<string>;

export type GitStatusEntry = {
	indexStatus: string;
	worktreeStatus: string;
	path: string;
	originalPath?: string;
	untracked: boolean;
	conflicted: boolean;
};

export type ParsedGitStatus = {
	branch: string;
	headOid: string | undefined;
	entries: GitStatusEntry[];
	stagedCount: number;
	unstagedCount: number;
	untrackedCount: number;
	conflictedCount: number;
};

export type GitSnapshot = ParsedGitStatus & {
	added: number;
	removed: number;
	lineStatsComplete: boolean;
	durationMs: number;
};

type CollectOptions = {
	signal?: AbortSignal;
	runGit?: GitRunner;
};

function abortError() {
	const error = new Error("Git status refresh aborted");
	error.name = "AbortError";
	return error;
}

export function isAbortError(error: unknown) {
	return error instanceof Error && error.name === "AbortError";
}

export const runGit: GitRunner = (args, cwd, signal) =>
	new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}

		execFile(
			"git",
			["--no-optional-locks", ...args],
			{
				cwd,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				encoding: "utf8",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				signal,
				timeout: DEFAULT_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolvePromise(stdout);
			},
		);
	});

function pathAfterFields(record: string, fieldCount: number) {
	let offset = 0;
	for (let field = 0; field < fieldCount; field += 1) {
		offset = record.indexOf(" ", offset);
		if (offset === -1) return "";
		offset += 1;
	}
	return record.slice(offset);
}

function parseBranch(headers: Map<string, string>) {
	const head = headers.get("branch.head");
	const oid = headers.get("branch.oid");
	if (head && head !== "(detached)" && head !== "(unknown)") return head;
	if (oid && oid !== "(initial)") return `detached@${oid.slice(0, 7)}`;
	return "unknown";
}

function statusEntry(record: string, originalPath?: string): GitStatusEntry | undefined {
	const type = record[0];
	if (type === "?") {
		return {
			indexStatus: ".",
			worktreeStatus: "?",
			path: record.slice(2),
			untracked: true,
			conflicted: false,
		};
	}
	if (type === "!") return undefined;

	const indexStatus = record[2];
	const worktreeStatus = record[3];
	if (!indexStatus || !worktreeStatus) return undefined;

	if (type === "1") {
		return {
			indexStatus,
			worktreeStatus,
			path: pathAfterFields(record, 8),
			untracked: false,
			conflicted: false,
		};
	}
	if (type === "2") {
		return {
			indexStatus,
			worktreeStatus,
			path: pathAfterFields(record, 9),
			originalPath,
			untracked: false,
			conflicted: false,
		};
	}
	if (type === "u") {
		return {
			indexStatus,
			worktreeStatus,
			path: pathAfterFields(record, 10),
			untracked: false,
			conflicted: true,
		};
	}
	return undefined;
}

export function parseStatusPorcelainV2(output: string): ParsedGitStatus {
	const headers = new Map<string, string>();
	const records = output.split("\0");
	const entries: GitStatusEntry[] = [];
	let stagedCount = 0;
	let unstagedCount = 0;
	let untrackedCount = 0;
	let conflictedCount = 0;
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("# ")) {
			const separator = record.indexOf(" ", 2);
			if (separator !== -1) {
				headers.set(record.slice(2, separator), record.slice(separator + 1));
			}
			continue;
		}
		const isRename = record.startsWith("2 ");
		const entry = statusEntry(record, isRename ? records[index + 1] : undefined);
		if (entry) {
			entries.push(entry);
			if (entry.indexStatus !== ".") stagedCount += 1;
			if (entry.untracked || entry.conflicted || entry.worktreeStatus !== ".") unstagedCount += 1;
			if (entry.untracked) untrackedCount += 1;
			if (entry.conflicted) conflictedCount += 1;
		}
		if (isRename) index += 1;
	}

	return {
		branch: parseBranch(headers),
		headOid: headers.get("branch.oid"),
		entries,
		stagedCount,
		unstagedCount,
		untrackedCount,
		conflictedCount,
	};
}

export function parseNumstat(output: string) {
	let added = 0;
	let removed = 0;
	for (const line of output.split("\n")) {
		if (!line) continue;
		const firstTab = line.indexOf("\t");
		const secondTab = line.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) continue;
		const additions = line.slice(0, firstTab);
		const deletions = line.slice(firstTab + 1, secondTab);
		if (additions !== "-") added += Number(additions) || 0;
		if (deletions !== "-") removed += Number(deletions) || 0;
	}
	return { added, removed };
}

function safeWorktreePath(cwd: string, path: string) {
	const absolute = resolve(cwd, path);
	const fromRoot = relative(resolve(cwd), absolute);
	if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
		return undefined;
	}
	if (isAbsolute(fromRoot)) return undefined;
	return absolute;
}

async function countTextLines(path: string, maxBytes: number) {
	const handle = await open(path, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let bytesSeen = 0;
	let lines = 0;
	let lastByte: number | undefined;
	try {
		while (true) {
			const allowed = Math.min(buffer.length, maxBytes - bytesSeen + 1);
			const { bytesRead } = await handle.read(buffer, 0, allowed);
			if (bytesRead === 0) {
				if (bytesSeen > 0 && lastByte !== 10) lines += 1;
				return { lines, complete: true };
			}
			bytesSeen += bytesRead;
			if (bytesSeen > maxBytes) return { lines: 0, complete: false };
			for (let index = 0; index < bytesRead; index += 1) {
				const byte = buffer[index];
				if (byte === 0) return { lines: 0, complete: true };
				if (byte === 10) lines += 1;
				lastByte = byte;
			}
		}
	} finally {
		await handle.close();
	}
}

async function getUntrackedLineStats(worktreeRoot: string, entries: GitStatusEntry[]) {
	const untracked = entries.filter((entry) => entry.untracked);
	let complete = untracked.length <= MAX_UNTRACKED_FILES_FOR_LINES;
	const selected: Array<{ path: string; maxBytes: number }> = [];
	let selectedBytes = 0;

	for (const entry of untracked.slice(0, MAX_UNTRACKED_FILES_FOR_LINES)) {
		if (entry.path.endsWith("/")) {
			complete = false;
			continue;
		}
		const path = safeWorktreePath(worktreeRoot, entry.path);
		if (!path) {
			complete = false;
			continue;
		}
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || selectedBytes + stat.size > MAX_UNTRACKED_BYTES_FOR_LINES) {
				complete = false;
				continue;
			}
			selected.push({ path, maxBytes: stat.size });
			selectedBytes += stat.size;
		} catch {
			complete = false;
		}
	}

	let added = 0;
	for (let offset = 0; offset < selected.length; offset += UNTRACKED_READ_CONCURRENCY) {
		const counts = await Promise.all(
			selected.slice(offset, offset + UNTRACKED_READ_CONCURRENCY).map(async ({ path, maxBytes }) => {
				try {
					return await countTextLines(path, maxBytes);
				} catch {
					complete = false;
					return { lines: 0, complete: false };
				}
			}),
		);
		for (const count of counts) {
			added += count.lines;
			if (!count.complete) complete = false;
		}
	}
	return { added, complete };
}

async function getTrackedLineStats(
	cwd: string,
	headOid: string | undefined,
	execute: GitRunner,
	signal: AbortSignal | undefined,
) {
	if (headOid !== "(initial)") {
		return parseNumstat(await execute(["diff", "HEAD", "--numstat", "--"], cwd, signal));
	}
	const objectFormat = (await execute(["rev-parse", "--show-object-format"], cwd, signal)).trim();
	const emptyTree = EMPTY_TREES[objectFormat as keyof typeof EMPTY_TREES];
	if (!emptyTree) throw new Error(`Unsupported Git object format: ${objectFormat}`);
	return parseNumstat(await execute(["diff", emptyTree, "--numstat", "--"], cwd, signal));
}

export async function collectGitSnapshot(cwd: string, options: CollectOptions = {}): Promise<GitSnapshot> {
	const startedAt = performance.now();
	const execute = options.runGit ?? runGit;
	const statusOutput = await execute(
		["status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--untracked-files=normal"],
		cwd,
		options.signal,
	);
	const status = parseStatusPorcelainV2(statusOutput);

	let added = 0;
	let removed = 0;
	let lineStatsComplete = true;
	if (status.entries.length > 0) {
		const hasTrackedEntries = status.entries.some((entry) => !entry.untracked);
		const trackedPromise = hasTrackedEntries
			? getTrackedLineStats(cwd, status.headOid, execute, options.signal)
			: Promise.resolve({ added: 0, removed: 0 });
		const untrackedPromise =
			status.untrackedCount > 0
				? execute(["rev-parse", "--show-toplevel"], cwd, options.signal).then((root) =>
						getUntrackedLineStats(root.trim(), status.entries),
					)
				: Promise.resolve({ added: 0, complete: true });
		const [tracked, untracked] = await Promise.all([
			trackedPromise,
			untrackedPromise,
		]);
		added = tracked.added + untracked.added;
		removed = tracked.removed;
		lineStatsComplete = untracked.complete;
	}

	return {
		...status,
		added,
		removed,
		lineStatsComplete,
		durationMs: performance.now() - startedAt,
	};
}
