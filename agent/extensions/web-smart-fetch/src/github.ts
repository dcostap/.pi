import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionConfig } from "./config.ts";
import { readResponseText } from "./response-body.ts";
import { ensureDir, listTree, readMaybe } from "./utils.ts";

const execFileAsync = promisify(execFile);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, ms);
		const onAbort = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		};
		function cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
		function done() {
			cleanup();
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
const REPO_LOCK_STALE_MS = 30 * 60 * 1000;
const GIT_INDEX_LOCK_STALE_MS = 10 * 60 * 1000;
export const GITHUB_GIT_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

type RepoLock = { path: string };
type ProgressReporter = (message: string) => void;

function formatElapsed(ms: number): string {
	const seconds = Math.max(1, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m ${rest}s` : `${seconds}s`;
}

async function withProgress<T>(onProgress: ProgressReporter | undefined, message: string, fn: () => Promise<T>): Promise<T> {
	onProgress?.(message);
	const start = Date.now();
	const interval = setInterval(() => {
		onProgress?.(`${message} (${formatElapsed(Date.now() - start)} elapsed)`);
	}, 10_000);
	try {
		return await fn();
	} finally {
		clearInterval(interval);
	}
}

async function acquireRepoLock(
	config: ExtensionConfig,
	owner: string,
	repo: string,
	onProgress?: ProgressReporter,
	signal?: AbortSignal,
): Promise<RepoLock> {
	ensureDir(join(config.githubCacheDir, owner));
	const lockPath = join(config.githubCacheDir, owner, `${repo}.lock`);
	const start = Date.now();
	let warned = false;
	while (true) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
		if (Date.now() - start >= REPO_LOCK_WAIT_TIMEOUT_MS) {
			throw new Error(`Timed out after 5 minutes waiting for GitHub cache lock for ${owner}/${repo}`);
		}
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
					onProgress?.(`Removing stale GitHub cache lock for ${owner}/${repo}...`);
					await rm(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (!warned && Date.now() - start > 5_000) {
				warned = true;
				const ownerInfo = await readFile(join(lockPath, "owner.json"), "utf8").catch(() => "another pi agent");
				const message = `Waiting for GitHub cache lock for ${owner}/${repo} held by ${ownerInfo.trim()}`;
				onProgress?.(`${message} (${formatElapsed(Date.now() - start)} elapsed)`);
				console.error(message);
			} else if (warned) {
				onProgress?.(`Waiting for GitHub cache lock for ${owner}/${repo} (${formatElapsed(Date.now() - start)} elapsed)`);
			}
			await sleep(500 + Math.floor(Math.random() * 500), signal);
		}
	}
}

async function releaseRepoLock(lock: RepoLock) {
	await rmdir(lock.path).catch(async () => {
		await rm(lock.path, { recursive: true, force: true }).catch(() => undefined);
	});
}

async function withRepoLock<T>(
	config: ExtensionConfig,
	owner: string,
	repo: string,
	onProgress: ProgressReporter | undefined,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const lock = await acquireRepoLock(config, owner, repo, onProgress, signal);
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
	strategy: "github-api" | "github-sparse-checkout";
	cache: "none" | "managed";
	repoDir?: string;
	ref?: string;
	requestedPath?: string;
	localPath?: string;
	preview: string;
};

type ParsedGitHubUrl =
	| { owner: string; repo: string; mode: "root"; rest: string[] }
	| { owner: string; repo: string; mode: "tree"; rest: string[] }
	| { owner: string; repo: string; mode: "blob"; rest: string[] }
	| { owner: string; repo: string; mode: "raw"; rest: string[] }
	| { owner: string; repo: string; mode: "pull" | "issue"; number: number };

export function parseGitHubUrl(input: string): ParsedGitHubUrl | undefined {
	try {
		const url = new URL(input);
		const parts = url.pathname.split("/").filter(Boolean).map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		});
		const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
		const safeSlug = (value: string | undefined) => Boolean(value && /^[a-z\d_.-]+$/i.test(value) && value !== "." && value !== "..");
		const safeRest = (values: string[]) => values.every((value) => value !== "." && value !== ".." && !/[\\/\0]/.test(value));
		if (hostname === "raw.githubusercontent.com" && parts.length >= 4) {
			if (!safeSlug(parts[0]) || !safeSlug(parts[1]) || !safeRest(parts.slice(2))) return undefined;
			return {
				owner: parts[0],
				repo: parts[1],
				mode: "raw",
				rest: parts.slice(2),
			};
		}
		if (hostname !== "github.com" || parts.length < 2) return undefined;
		const [owner, repo, mode, ...rest] = parts;
		if (!safeSlug(owner) || !safeSlug(repo) || !safeRest(rest)) return undefined;

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

async function git(args: string[], cwd?: string, signal?: AbortSignal) {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		windowsHide: true,
		maxBuffer: 10 * 1024 * 1024,
		signal,
		timeout: GITHUB_GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
	} as any);
	return stdout.trim();
}

export function buildPartialCloneArgs(owner: string, repo: string, targetDir: string): string[] {
	return [
		"clone",
		"--depth=1",
		"--filter=blob:none",
		"--sparse",
		"--no-checkout",
		"--origin",
		"origin",
		`https://github.com/${owner}/${repo}.git`,
		targetDir,
	];
}

async function ensureRepo(config: ExtensionConfig, owner: string, repo: string, signal?: AbortSignal, onProgress?: ProgressReporter) {
	const ownerDir = ensureDir(join(config.githubCacheDir, owner));
	const repoDir = join(ownerDir, repo);
	if (!existsSync(join(repoDir, ".git"))) {
		const tempDir = join(ownerDir, `${repo}.tmp-${process.pid}-${Date.now()}`);
		await rm(repoDir, { recursive: true, force: true });
		await rm(tempDir, { recursive: true, force: true });
		try {
			await withProgress(onProgress, `Creating shallow sparse cache for ${owner}/${repo} (5 minute timeout)...`, () =>
				git(buildPartialCloneArgs(owner, repo, tempDir), undefined, signal),
			);
			await rename(tempDir, repoDir);
		} catch (error) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	} else {
		await cleanupStaleGitIndexLock(repoDir);
	}
	return repoDir;
}

async function getRemoteRefs(owner: string, repo: string, signal?: AbortSignal): Promise<{ defaultRef: string; refs: Set<string> }> {
	const remote = `https://github.com/${owner}/${repo}.git`;
	const raw = await git(["ls-remote", "--symref", remote, "HEAD", "refs/heads/*", "refs/tags/*"], undefined, signal);
	const refs = new Set<string>();
	let defaultRef = "main";
	for (const line of raw.split(/\r?\n/)) {
		const symbolic = line.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/);
		if (symbolic) defaultRef = symbolic[1];
		const refName = line.split(/\s+/)[1]?.replace(/\^\{\}$/, "");
		if (refName?.startsWith("refs/heads/")) refs.add(refName.slice("refs/heads/".length));
		if (refName?.startsWith("refs/tags/")) refs.add(refName.slice("refs/tags/".length));
	}
	refs.add(defaultRef);
	return { defaultRef, refs };
}

async function getRemoteDefaultRef(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
	const remote = `https://github.com/${owner}/${repo}.git`;
	const raw = await git(["ls-remote", "--symref", remote, "HEAD"], undefined, signal);
	return raw.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m)?.[1] || "main";
}

async function resolveRemoteRefAndPath(owner: string, repo: string, mode: "root" | "tree" | "blob" | "raw", rest: string[], signal?: AbortSignal) {
	if (mode === "root") return { ref: await getRemoteDefaultRef(owner, repo, signal), relPath: "" };
	const remote = await getRemoteRefs(owner, repo, signal);
	for (let i = rest.length; i >= 1; i--) {
		const maybeRef = rest.slice(0, i).join("/");
		if (remote.refs.has(maybeRef)) {
			return { ref: maybeRef, relPath: rest.slice(i).join("/") };
		}
	}
	return { ref: rest[0] || remote.defaultRef, relPath: rest.slice(1).join("/") };
}

async function checkoutSparse(repoDir: string, ref: string, relPath: string, signal?: AbortSignal, onProgress?: ProgressReporter) {
	await cleanupStaleGitIndexLock(repoDir);
	await git(["sparse-checkout", "init", "--cone"], repoDir, signal);
	await git(["sparse-checkout", "set", "--cone", ...(relPath ? [relPath] : [])], repoDir, signal);
	await withProgress(onProgress, `Fetching ${ref} with depth 1...`, () =>
		git(["fetch", "--depth=1", "--filter=blob:none", "--prune", "origin", ref], repoDir, signal),
	);
	await withProgress(onProgress, `Checking out ${ref} sparsely...`, () => git(["checkout", "--force", "FETCH_HEAD"], repoDir, signal));
}

async function fetchGitHubJson(apiPath: string, maxBytes: number, signal?: AbortSignal) {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("GitHub API request timed out after 5 minutes")),
		GITHUB_GIT_TIMEOUT_MS,
	);
	const onAbort = () => controller.abort(signal?.reason || new Error("Operation aborted"));
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(`https://api.github.com${apiPath}`, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Pi-Web-Smart-Fetch/0.1",
				"X-GitHub-Api-Version": "2022-11-28",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			signal: controller.signal,
		});
		const text = await readResponseText(res, maxBytes, "GitHub API response", controller.signal);
		if (!res.ok) throw new Error(`GitHub API failed: ${res.status} ${res.statusText}`);
		return text ? JSON.parse(text) : {};
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

function encodeApiPath(path: string): string {
	return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function formatGitHubContentsPreview(
	owner: string,
	repo: string,
	ref: string,
	relPath: string,
	contents: any,
): string {
	if (Array.isArray(contents)) {
		const entries = contents.slice(0, 140).map((entry: any) => {
			const type = entry?.type === "dir" ? "dir" : entry?.type || "file";
			const suffix = type === "dir" ? "/" : "";
			const size = type === "file" && Number.isFinite(entry?.size) ? ` (${entry.size} bytes)` : "";
			return `- [${type}] ${entry?.name || "(unnamed)"}${suffix}${size}`;
		});
		return [
			`Directory: ${relPath || "/"}`,
			`Repository: ${owner}/${repo}`,
			`Ref: ${ref}`,
			"Source: GitHub Contents API (no repository clone)",
			"",
			...entries,
			contents.length > entries.length ? `\n[${contents.length - entries.length} additional entries omitted]` : "",
		].filter(Boolean).join("\n");
	}

	const encoded = typeof contents?.content === "string" ? contents.content.replace(/\s+/g, "") : "";
	const decoded = contents?.encoding === "base64" && encoded
		? Buffer.from(encoded, "base64").toString("utf8")
		: "";
	const text = decoded.slice(0, 20_000);
	const truncated = decoded.length > text.length;
	const unavailable = !decoded && contents?.type === "file";
	return [
		`File: ${relPath || contents?.name || "/"}`,
		`Repository: ${owner}/${repo}`,
		`Ref: ${ref}`,
		"Source: GitHub Contents API (no repository clone)",
		Number.isFinite(contents?.size) ? `Size: ${contents.size} bytes` : "",
		unavailable ? "Content unavailable through the GitHub Contents API; use the raw/download URL or a sparse checkout." : undefined,
		unavailable && contents?.download_url ? `Download URL: ${contents.download_url}` : undefined,
		text || undefined,
		truncated ? `\n[GitHub API file preview truncated at 20,000 characters; decoded content has ${decoded.length} characters]` : undefined,
	].filter((line) => line !== undefined && line !== "").join("\n");
}

async function handleGitHubTree(
	config: ExtensionConfig,
	parsed: Extract<ParsedGitHubUrl, { mode: "tree" }>,
	url: string,
	onProgress?: ProgressReporter,
	signal?: AbortSignal,
): Promise<GitHubResolution> {
	const fetchContents = (ref: string, relPath: string) => fetchGitHubJson(
		`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${encodeApiPath(relPath)}?ref=${encodeURIComponent(ref)}`,
		config.maxTextResponseBytes,
		signal,
	);

	let resolved = parsed.rest.length > 0
		? { ref: parsed.rest[0], relPath: parsed.rest.slice(1).join("/") }
		: { ref: await getRemoteDefaultRef(parsed.owner, parsed.repo, signal), relPath: "" };
	onProgress?.(`Listing ${resolved.relPath || "/"} through the GitHub Contents API...`);
	let contents: any;
	try {
		contents = await fetchContents(resolved.ref, resolved.relPath);
	} catch (firstError) {
		if (signal?.aborted) throw firstError;
		// The common URL shape has a one-segment ref and needs no git operation.
		// Only consult remote refs when that API request fails, which preserves
		// support for branch/tag names containing slashes.
		onProgress?.(`Resolving a possible slash-containing GitHub ref without cloning...`);
		const retry = await resolveRemoteRefAndPath(parsed.owner, parsed.repo, parsed.mode, parsed.rest, signal);
		if (retry.ref === resolved.ref && retry.relPath === resolved.relPath) throw firstError;
		resolved = retry;
		onProgress?.(`Retrying ${resolved.relPath || "/"} through the GitHub Contents API at ${resolved.ref}...`);
		contents = await fetchContents(resolved.ref, resolved.relPath);
	}
	return {
		kind: "github",
		url,
		owner: parsed.owner,
		repo: parsed.repo,
		strategy: "github-api",
		cache: "none",
		ref: resolved.ref,
		requestedPath: resolved.relPath || undefined,
		preview: formatGitHubContentsPreview(parsed.owner, parsed.repo, resolved.ref, resolved.relPath, contents),
	};
}

function formatUser(user: any): string {
	return user?.login ? `@${user.login}` : "unknown";
}

async function handleGitHubPullOrIssue(
	config: ExtensionConfig,
	parsed: Extract<ParsedGitHubUrl, { mode: "pull" | "issue" }>,
	url: string,
	signal?: AbortSignal,
): Promise<GitHubResolution> {
	if (parsed.mode === "pull") {
		const pr: any = await fetchGitHubJson(
			`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
			config.maxTextResponseBytes,
			signal,
		);
		const files: any[] = await fetchGitHubJson(
			`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files?per_page=100`,
			config.maxTextResponseBytes,
			signal,
		);
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
		return {
			kind: "github",
			url,
			owner: parsed.owner,
			repo: parsed.repo,
			strategy: "github-api",
			cache: "none",
			preview,
		};
	}

	const issue: any = await fetchGitHubJson(
		`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
		config.maxTextResponseBytes,
		signal,
	);
	const comments: any[] = await fetchGitHubJson(
		`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=20`,
		config.maxTextResponseBytes,
		signal,
	);
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
	return {
		kind: "github",
		url,
		owner: parsed.owner,
		repo: parsed.repo,
		strategy: "github-api",
		cache: "none",
		preview,
	};
}

export async function handleGitHubUrl(config: ExtensionConfig, url: string, onProgress?: ProgressReporter, signal?: AbortSignal): Promise<GitHubResolution> {
	const parsed = parseGitHubUrl(url);
	if (!parsed) throw new Error("Not a GitHub URL");
	if (parsed.mode === "pull" || parsed.mode === "issue") return handleGitHubPullOrIssue(config, parsed, url, signal);
	if (parsed.mode === "raw" || parsed.mode === "blob") {
		throw new Error("Raw and blob GitHub URLs must be routed through the direct HTTP fetcher");
	}
	if (parsed.mode === "tree") {
		try {
			return await handleGitHubTree(config, parsed, url, onProgress, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			onProgress?.(`GitHub Contents API unavailable (${reason}). Falling back to a shallow sparse checkout...`);
		}
	}

	const sourceUrl = parsed as Extract<ParsedGitHubUrl, { mode: "root" | "tree" }>;
	const resolved = await resolveRemoteRefAndPath(sourceUrl.owner, sourceUrl.repo, sourceUrl.mode, sourceUrl.rest, signal);
	return await withRepoLock(config, sourceUrl.owner, sourceUrl.repo, onProgress, signal, async () => {
		const repoDir = await ensureRepo(config, sourceUrl.owner, sourceUrl.repo, signal, onProgress);
		await checkoutSparse(repoDir, resolved.ref, resolved.relPath, signal, onProgress);

		const localPath = resolved.relPath ? join(repoDir, resolved.relPath) : repoDir;
		let preview = "";
		if (!resolved.relPath) {
			preview = [
				`Repository: ${parsed.owner}/${parsed.repo}`,
				`Ref: ${resolved.ref}`,
				`Local path: ${repoDir}`,
				"Checkout: shallow, blob-filtered, sparse (top-level files only)",
				"",
				...listTree(repoDir, 140, 1),
			].join("\n");
		} else if (existsSync(localPath) && statSync(localPath).isDirectory()) {
			preview = [`Directory: ${resolved.relPath}`, `Ref: ${resolved.ref}`, `Local path: ${localPath}`, "", listTree(localPath, 140, 2).join("\n")].join("\n");
		} else {
			onProgress?.(`Reading ${resolved.relPath} from ${sourceUrl.owner}/${sourceUrl.repo}...`);
			const text = readMaybe(localPath) ?? (await git(["show", `${resolved.ref}:${resolved.relPath}`], repoDir, signal).catch(() => ""));
			preview = [`File: ${resolved.relPath}`, `Ref: ${resolved.ref}`, `Local path: ${localPath}`, "", text.slice(0, 20000)].join("\n");
		}

		return {
			kind: "github",
			url,
			owner: parsed.owner,
			repo: parsed.repo,
			strategy: "github-sparse-checkout",
			cache: "managed",
			repoDir,
			ref: resolved.ref,
			requestedPath: resolved.relPath || undefined,
			localPath,
			preview,
		};
	});
}
