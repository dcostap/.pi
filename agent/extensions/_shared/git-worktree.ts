import { basename } from "node:path";

type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

function normalizePath(path: string) {
	const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? forward.toLowerCase() : forward;
}

// Returns the folder name of a linked worktree, or undefined in a main checkout or outside Git.
// A linked worktree has its own Git folder. The main checkout's Git folder is the common folder.
export async function getLinkedWorktree(cwd: string, runGit: GitRunner, signal?: AbortSignal) {
	const output = await runGit(
		["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
		cwd,
		signal,
	).catch(() => "");
	const [gitDir, commonDir, topLevel] = output.trim().split(/\r?\n/);
	if (!gitDir || !commonDir || !topLevel) return undefined;
	return normalizePath(gitDir) === normalizePath(commonDir) ? undefined : basename(topLevel);
}
