import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionConfig } from "./config.ts";
import { ensureDir, listTree, readMaybe } from "./utils.ts";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REPO_LOCK_STALE_MS = 30 * 60 * 1000;
const GIT_INDEX_LOCK_STALE_MS = 10 * 60 * 1000;

type RepoLock = { path: string };

async function acquireRepoLock(config: ExtensionConfig, owner: string, repo: string): Promise<RepoLock> {
	ensureDir(join(config.githubCacheDir, owner));
	const lockPath = join(config.githubCacheDir, owner, `${repo}.lock`);
	const start = Date.now();
	let warned = false;
	while (true) {
		try {
			await mkdir(lockPath);
			await writeFile(
				join(lockPath, "owner.json"),
				JSON.stringify({ pid: process.pid, owner, repo, startedAt: new Date().toISOString() }, null, 2),
			);
			return { path: lockPath };
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const stat = statSync(lockPath);
				if (Date.now() - stat.mtimeMs > REPO_LOCK_STALE_MS) {
					await rm(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (!warned && Date.now() - start > 5_000) {
				warned = true;
				const ownerInfo = await readFile(join(lockPath, "owner.json"), "utf8").catch(() => "another pi agent");
				console.error(`Waiting for GitHub cache lock for ${owner}/${repo} held by ${ownerInfo.trim()}`);
			}
			await sleep(500 + Math.floor(Math.random() * 500));
		}
	}
}

async function releaseRepoLock(lock: RepoLock) {
	await rmdir(lock.path).catch(async () => {
		await rm(lock.path, { recursive: true, force: true }).catch(() => undefined);
	});
}

async function withRepoLock<T>(config: ExtensionConfig, owner: string, repo: string, fn: () => Promise<T>): Promise<T> {
	const lock = await acquireRepoLock(config, owner, repo);
	try {
		return await fn();
	} finally {
		await releaseRepoLock(lock);
	}
}

async function cleanupStaleGitIndexLock(repoDir: string) {
	const indexLock = join(repoDir, ".git", "index.lock");
	if (!existsSync(indexLock)) return;
	try {
		const stat = statSync(indexLock);
		if (Date.now() - stat.mtimeMs > GIT_INDEX_LOCK_STALE_MS) {
			await rm(indexLock, { force: true });
		}
	} catch {
		// If the lock disappears between exists/stat/rm, git can proceed normally.
	}
}

export type GitHubResolution = {
	kind: "github";
	url: string;
	owner: string;
	repo: string;
	repoDir?: string;
	ref?: string;
	requestedPath?: string;
	localPath?: string;
	preview: string;
};

type ParsedGitHubUrl =
	| { owner: string; repo: string; mode: "root" | "tree" | "blob" | "raw"; rest: string[] }
	| { owner: string; repo: string; mode: "pull" | "issue"; number: number };

export function parseGitHubUrl(input: string): ParsedGitHubUrl | undefined {
	try {
		const url = new URL(input);
		const parts = url.pathname.split("/").filter(Boolean);
		if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
			return {
				owner: parts[0],
				repo: parts[1],
				mode: "raw",
				rest: parts.slice(2),
			};
		}
		if (url.hostname !== "github.com" || parts.length < 2) return undefined;
		const [owner, repo, mode, ...rest] = parts;
		if (!owner || !repo) return undefined;

		// Only treat exact repository URLs and source URLs as clone-backed GitHub URLs.
		// Other github.com pages should either use a targeted API fetch below or fall
		// through to the normal page fetcher; otherwise /pull/123, /issues/123, etc.
		// get incorrectly collapsed to the repository root.
		if (!mode) return { owner, repo, mode: "root", rest: [] };
		if (mode === "tree" || mode === "blob") return { owner, repo, mode, rest };
		if ((mode === "pull" || mode === "issues") && rest[0] && /^\d+$/.test(rest[0])) {
			return { owner, repo, mode: mode === "pull" ? "pull" : "issue", number: Number(rest[0]) };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function git(args: string[], cwd?: string) {
	const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function ensureRepo(config: ExtensionConfig, owner: string, repo: string) {
	const repoDir = ensureDir(join(config.githubCacheDir, owner, repo));
	if (!existsSync(join(repoDir, ".git"))) {
		await git([
			"clone",
			"--filter=blob:none",
			"--origin",
			"origin",
			`https://github.com/${owner}/${repo}.git`,
			repoDir,
		]);
	} else {
		await cleanupStaleGitIndexLock(repoDir);
		await git(["fetch", "--all", "--tags", "--prune"], repoDir);
	}
	return repoDir;
}

async function getRefs(repoDir: string): Promise<string[]> {
	const raw = await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin", "refs/tags"], repoDir);
	return raw
		.split(/\r?\n/)
		.map((s) => s.replace(/^origin\//, ""))
		.filter(Boolean);
}

async function getDefaultRef(repoDir: string): Promise<string> {
	const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoDir).catch(() => "origin/main");
	return ref.replace(/^origin\//, "");
}

async function resolveRefAndPath(repoDir: string, mode: "root" | "tree" | "blob" | "raw", rest: string[]) {
	if (mode === "root") return { ref: await getDefaultRef(repoDir), relPath: "" };
	const refs = new Set(await getRefs(repoDir));
	for (let i = rest.length; i >= 1; i--) {
		const maybeRef = rest.slice(0, i).join("/");
		if (refs.has(maybeRef)) {
			return { ref: maybeRef, relPath: rest.slice(i).join("/") };
		}
	}
	return { ref: rest[0] || (await getDefaultRef(repoDir)), relPath: rest.slice(1).join("/") };
}

async function checkout(repoDir: string, ref: string) {
	await cleanupStaleGitIndexLock(repoDir);
	await git(["checkout", "--force", ref], repoDir);
}

async function fetchGitHubJson(apiPath: string) {
	const res = await fetch(`https://api.github.com${apiPath}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "Pi-Web-Smart-Fetch/0.1",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!res.ok) throw new Error(`GitHub API failed: ${res.status} ${res.statusText}`);
	return await res.json();
}

function formatUser(user: any): string {
	return user?.login ? `@${user.login}` : "unknown";
}

async function handleGitHubPullOrIssue(parsed: Extract<ParsedGitHubUrl, { mode: "pull" | "issue" }>, url: string): Promise<GitHubResolution> {
	if (parsed.mode === "pull") {
		const pr: any = await fetchGitHubJson(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`);
		const files: any[] = await fetchGitHubJson(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files?per_page=100`);
		const preview = [
			`Pull request: ${parsed.owner}/${parsed.repo}#${parsed.number}`,
			`Title: ${pr.title}`,
			`State: ${pr.state}${pr.merged ? " (merged)" : ""}`,
			`Author: ${formatUser(pr.user)}`,
			`Base: ${pr.base?.ref} @ ${pr.base?.repo?.full_name}`,
			`Head: ${pr.head?.ref} @ ${pr.head?.repo?.full_name}`,
			`URL: ${pr.html_url || url}`,
			`Changed files: ${pr.changed_files ?? files.length} (+${pr.additions ?? "?"}/-${pr.deletions ?? "?"})`,
			"",
			"Body:",
			pr.body || "(empty)",
			"",
			"Files:",
			...files.map((file) => `- ${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`),
		].join("\n");
		return { kind: "github", url, owner: parsed.owner, repo: parsed.repo, preview };
	}

	const issue: any = await fetchGitHubJson(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`);
	const comments: any[] = await fetchGitHubJson(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=20`);
	const preview = [
		`Issue: ${parsed.owner}/${parsed.repo}#${parsed.number}`,
		`Title: ${issue.title}`,
		`State: ${issue.state}`,
		`Author: ${formatUser(issue.user)}`,
		`URL: ${issue.html_url || url}`,
		"",
		"Body:",
		issue.body || "(empty)",
		comments.length ? "\nRecent comments:" : "",
		...comments.map((comment) => `\n${formatUser(comment.user)} at ${comment.created_at}:\n${comment.body || "(empty)"}`),
	].join("\n");
	return { kind: "github", url, owner: parsed.owner, repo: parsed.repo, preview };
}

export async function handleGitHubUrl(config: ExtensionConfig, url: string): Promise<GitHubResolution> {
	const parsed = parseGitHubUrl(url);
	if (!parsed) throw new Error("Not a GitHub URL");
	if (parsed.mode === "pull" || parsed.mode === "issue") return handleGitHubPullOrIssue(parsed, url);

	const sourceUrl = parsed as Extract<ParsedGitHubUrl, { mode: "root" | "tree" | "blob" | "raw" }>;
	return await withRepoLock(config, sourceUrl.owner, sourceUrl.repo, async () => {
		const repoDir = await ensureRepo(config, sourceUrl.owner, sourceUrl.repo);
		const resolved = await resolveRefAndPath(repoDir, sourceUrl.mode, sourceUrl.rest);
		await checkout(repoDir, resolved.ref);

		const localPath = resolved.relPath ? join(repoDir, resolved.relPath) : repoDir;
		let preview = "";
		if (!resolved.relPath) {
			preview = [
				`Repository: ${parsed.owner}/${parsed.repo}`,
				`Ref: ${resolved.ref}`,
				`Local path: ${repoDir}`,
			].join("\n");
		} else if (existsSync(localPath) && statSync(localPath).isDirectory()) {
			preview = [`Directory: ${resolved.relPath}`, `Ref: ${resolved.ref}`, `Local path: ${localPath}`, "", listTree(localPath, 140, 2).join("\n")].join("\n");
		} else {
			const text = readMaybe(localPath) ?? (await git(["show", `${resolved.ref}:${resolved.relPath}`], repoDir).catch(() => ""));
			preview = [`File: ${resolved.relPath}`, `Ref: ${resolved.ref}`, `Local path: ${localPath}`, "", text.slice(0, 20000)].join("\n");
		}

		return {
			kind: "github",
			url,
			owner: parsed.owner,
			repo: parsed.repo,
			repoDir,
			ref: resolved.ref,
			requestedPath: resolved.relPath || undefined,
			localPath,
			preview,
		};
	});
}
