import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export type GitRunner = (
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<string>;

export type ParsedGitStatus = {
	branch: string;
	headOid: string | undefined;
	changeCount: number;
	hasTrackedChanges: boolean;
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

function parseBranch(headers: Map<string, string>) {
	const head = headers.get("branch.head");
	const oid = headers.get("branch.oid");
	if (head && head !== "(detached)" && head !== "(unknown)") return head;
	if (oid && oid !== "(initial)") return `detached@${oid.slice(0, 7)}`;
	return "unknown";
}

export function parseStatusPorcelainV2(output: string): ParsedGitStatus {
	const headers = new Map<string, string>();
	let changeCount = 0;
	let hasTrackedChanges = false;
	let stagedCount = 0;
	let unstagedCount = 0;
	let untrackedCount = 0;
	let conflictedCount = 0;
	let offset = 0;
	while (offset < output.length) {
		const separator = output.indexOf("\0", offset);
		const end = separator === -1 ? output.length : separator;
		const record = output.slice(offset, end);
		offset = end + 1;
		if (!record) continue;
		if (record.startsWith("# ")) {
			const headerSeparator = record.indexOf(" ", 2);
			if (headerSeparator !== -1) {
				headers.set(record.slice(2, headerSeparator), record.slice(headerSeparator + 1));
			}
			continue;
		}

		const type = record[0];
		if (type === "?") {
			changeCount += 1;
			unstagedCount += 1;
			untrackedCount += 1;
			continue;
		}
		if (type === "u") {
			changeCount += 1;
			hasTrackedChanges = true;
			conflictedCount += 1;
			continue;
		}
		if (type !== "1" && type !== "2") continue;

		const indexStatus = record[2];
		const worktreeStatus = record[3];
		if (indexStatus && worktreeStatus) {
			changeCount += 1;
			hasTrackedChanges = true;
			if (indexStatus !== ".") stagedCount += 1;
			if (worktreeStatus !== ".") unstagedCount += 1;
		}
		if (type === "2" && offset < output.length) {
			const originalPathEnd = output.indexOf("\0", offset);
			offset = originalPathEnd === -1 ? output.length : originalPathEnd + 1;
		}
	}

	return {
		branch: parseBranch(headers),
		headOid: headers.get("branch.oid"),
		changeCount,
		hasTrackedChanges,
		stagedCount,
		unstagedCount,
		untrackedCount,
		conflictedCount,
	};
}

export function parseNumstat(output: string) {
	let added = 0;
	let removed = 0;
	let offset = 0;
	while (offset < output.length) {
		const newline = output.indexOf("\n", offset);
		const end = newline === -1 ? output.length : newline;
		const line = output.slice(offset, end);
		offset = end + 1;
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

async function getTrackedLineStats(
	cwd: string,
	execute: GitRunner,
	signal: AbortSignal | undefined,
) {
	const [unstagedOutput, stagedOutput] = await Promise.all([
		execute(["diff", "--numstat", "--"], cwd, signal),
		execute(["diff", "--cached", "--numstat", "--"], cwd, signal),
	]);
	const unstaged = parseNumstat(unstagedOutput);
	const staged = parseNumstat(stagedOutput);
	return {
		added: unstaged.added + staged.added,
		removed: unstaged.removed + staged.removed,
	};
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
	if (status.hasTrackedChanges) {
		const tracked = await getTrackedLineStats(cwd, execute, options.signal);
		added = tracked.added;
		removed = tracked.removed;
	}

	return {
		...status,
		added,
		removed,
		lineStatsComplete: status.untrackedCount === 0,
		durationMs: performance.now() - startedAt,
	};
}
