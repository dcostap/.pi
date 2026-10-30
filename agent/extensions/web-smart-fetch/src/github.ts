import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionConfig } from "./config.ts";
import { readResponseText } from "./response-body.ts";
import { ensureDir } from "./utils.ts";

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
	strategy: "github-api" | "github-checkout";
	repoDir?: string;
	ref?: string;
	requestedPath?: string;
	localPath?: string;
	preview: string;
	/**
	 * Bounded source material for focused questions. This is deliberately
	 * separate from `preview`: previews contain transport/path metadata while
	 * this value contains the actual file text when it is available.
	 */
	content: string;
	contentKind: "api" | "text" | "listing";
	contentTruncated?: boolean;
};

type ParsedGitHubUrl =
	| { owner: string; repo: string; mode: "root"; rest: string[] }
	| { owner: string; repo: string; mode: "tree"; rest: string[] }
	| { owner: string; repo: string; mode: "blob"; rest: string[] }
	| { owner: string; repo: string; mode: "raw"; rest: string[] }
	| { owner: string; repo: string; mode: "commit"; ref: string }
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

		// Only treat exact repository URLs and source URLs as checkout-backed GitHub URLs.
		// Other github.com pages should either use a targeted API fetch below or fall
		// through to the normal page fetcher; otherwise /pull/123, /issues/123, etc.
		// get incorrectly collapsed to the repository root.
		if (!mode) return { owner, repo, mode: "root", rest: [] };
		if (mode === "tree" || mode === "blob") return { owner, repo, mode, rest };
		if (mode === "commit" && rest.length === 1 && /^[a-f\d]{7,64}$/i.test(rest[0])) {
			return { owner, repo, mode: "commit", ref: rest[0] };
		}
		if ((mode === "pull" || mode === "issues") && rest[0] && /^\d+$/.test(rest[0])) {
			return { owner, repo, mode: mode === "pull" ? "pull" : "issue", number: Number(rest[0]) };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function git(args: string[], cwd?: string, signal?: AbortSignal, trim = true) {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		windowsHide: true,
		maxBuffer: 64 * 1024 * 1024,
		signal,
		timeout: GITHUB_GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_LFS_SKIP_SMUDGE: "1" },
	} as any);
	return trim ? String(stdout).trim() : String(stdout);
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

async function resolveRemoteRefAndPath(owner: string, repo: string, mode: "root" | "tree", rest: string[], signal?: AbortSignal) {
	if (mode === "root" || rest.length === 0) return { ref: await getRemoteDefaultRef(owner, repo, signal), relPath: "" };
	const remote = await getRemoteRefs(owner, repo, signal);
	for (let i = rest.length; i >= 1; i--) {
		const maybeRef = rest.slice(0, i).join("/");
		if (remote.refs.has(maybeRef)) {
			return { ref: maybeRef, relPath: rest.slice(i).join("/") };
		}
	}
	return { ref: rest[0], relPath: rest.slice(1).join("/") };
}

/** Repositories with more file bytes than this at the requested commit get a sparse checkout. */
export const FULL_CHECKOUT_MAX_BYTES = 500 * 1024 * 1024;
/** When GitHub cannot report the size, repositories with more files than this get a sparse checkout. */
export const FULL_CHECKOUT_MAX_FILES = 20_000;
const TREE_API_MAX_BYTES = 64 * 1024 * 1024;
const LISTING_MAX_ENTRIES = 200;

export type TreeEntry = { path: string; type: string };

type Checkout = {
	dir: string;
	sha: string;
	entries: TreeEntry[];
	fileCount: number;
	sparse: boolean;
	/** Why the checkout is sparse. Kept in the checkout's git config. */
	sparseReason?: string;
	/** Folders on disk in a sparse checkout, besides the root files. */
	sparsePaths: string[];
};

/** Parses `git ls-tree -r -t -z` output. */
export function parseLsTree(output: string): TreeEntry[] {
	return output.split("\0").filter(Boolean).map((line) => {
		const tab = line.indexOf("\t");
		return { type: line.slice(0, tab).split(" ")[1], path: line.slice(tab + 1) };
	});
}

/** Folder name of one ref's checkout. Refs can contain slashes. */
export function checkoutDirName(ref: string): string {
	return encodeURIComponent(ref);
}

/** Lists the entries below `relPath` two levels deep, or one level when that is too long. */
export function formatListing(entries: TreeEntry[], relPath: string): string[] {
	const prefix = relPath ? `${relPath}/` : "";
	const below = entries
		.filter((entry) => entry.path.startsWith(prefix))
		.map((entry) => ({ path: entry.path.slice(prefix.length), dir: entry.type !== "blob" }));
	const depth = (path: string) => path.split("/").length;
	let shown = below.filter((entry) => depth(entry.path) <= 2);
	if (shown.length > LISTING_MAX_ENTRIES) shown = below.filter((entry) => depth(entry.path) === 1);
	const lines = shown.slice(0, LISTING_MAX_ENTRIES).map((entry) => `${entry.path}${entry.dir ? "/" : ""}`);
	if (shown.length > LISTING_MAX_ENTRIES) lines.push(`[${shown.length - LISTING_MAX_ENTRIES} more entries]`);
	return lines;
}

/** Sums file sizes at one commit with the GitHub trees API, without downloading the files. */
async function measureFileBytes(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<{ bytes?: number; reason?: string }> {
	try {
		const tree: any = await fetchGitHubJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${sha}?recursive=1`,
			TREE_API_MAX_BYTES,
			signal,
		);
		if (tree?.truncated || !Array.isArray(tree?.tree)) return { reason: "GitHub could not report their size" };
		return { bytes: tree.tree.reduce((sum: number, entry: any) => sum + (entry?.type === "blob" ? Number(entry.size) || 0 : 0), 0) };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { reason: `the size check failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function formatMegabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;
}

async function initCheckout(owner: string, repo: string, dir: string, signal?: AbortSignal) {
	const tempDir = `${dir}.tmp-${process.pid}-${Date.now()}`;
	await rm(dir, { recursive: true, force: true });
	await mkdir(tempDir, { recursive: true });
	try {
		await git(["init", "--quiet"], tempDir, signal);
		await git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], tempDir, signal);
		// A partial clone remote lets git download file contents on demand.
		await git(["config", "remote.origin.promisor", "true"], tempDir, signal);
		await git(["config", "remote.origin.partialclonefilter", "blob:none"], tempDir, signal);
		await git(["config", "core.longpaths", "true"], tempDir, signal);
		await rename(tempDir, dir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Brings the checkout of one ref up to date. A new checkout is full when the
 * files at that commit are small enough, otherwise sparse. In a sparse
 * checkout, each requested folder is added and stays on disk.
 */
async function ensureCheckout(
	config: ExtensionConfig,
	owner: string,
	repo: string,
	ref: string,
	relPath: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<Checkout> {
	const repoRoot = join(config.githubCacheDir, owner, repo);
	if (existsSync(join(repoRoot, ".git"))) {
		// Older versions kept one sparse checkout directly in the repository folder.
		onProgress?.(`Removing the old cache of ${owner}/${repo}...`);
		await rm(repoRoot, { recursive: true, force: true });
	}
	const dir = join(repoRoot, checkoutDirName(ref));
	if (!existsSync(join(dir, ".git"))) await initCheckout(owner, repo, dir, signal);
	else await cleanupStaleGitIndexLock(dir);

	await withProgress(onProgress, `Fetching ${owner}/${repo} at ${ref}...`, () =>
		git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", ref], dir, signal),
	);
	const sha = await git(["rev-parse", "FETCH_HEAD"], dir, signal);
	const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir, signal).catch(() => "");
	const entries = parseLsTree(await git(["ls-tree", "-r", "-t", "-z", sha], dir, signal));
	const fileCount = entries.filter((entry) => entry.type === "blob").length;
	const target = relPath ? entries.find((entry) => entry.path === relPath) : undefined;
	if (relPath && !target) throw new Error(`${relPath} does not exist in ${owner}/${repo} at ${ref}`);

	let sparseReason = await git(["config", "--get", "pi.sparseReason"], dir, signal).catch(() => "");
	if (!head) {
		onProgress?.(`Checking the size of ${owner}/${repo}...`);
		const size = await measureFileBytes(owner, repo, sha, signal);
		if (size.bytes !== undefined) {
			sparseReason = size.bytes > FULL_CHECKOUT_MAX_BYTES ? `the files total ${formatMegabytes(size.bytes)}` : "";
		} else {
			sparseReason = fileCount > FULL_CHECKOUT_MAX_FILES
				? `more than ${FULL_CHECKOUT_MAX_FILES.toLocaleString("en-US")} files, and ${size.reason}`
				: "";
		}
		if (sparseReason) {
			await git(["config", "pi.sparseReason", sparseReason], dir, signal);
			await git(["sparse-checkout", "set", "--cone"], dir, signal);
		}
	}
	const sparse = Boolean(sparseReason);

	if (head !== sha) {
		const message = sparse || head
			? `Checking out ${owner}/${repo} at ${ref}...`
			: `Downloading ${fileCount.toLocaleString("en-US")} files of ${owner}/${repo}...`;
		await withProgress(onProgress, message, () => git(["checkout", "--quiet", "--force", "--detach", sha], dir, signal));
	}

	let sparsePaths: string[] = [];
	if (sparse) {
		sparsePaths = (await git(["sparse-checkout", "list"], dir, signal)).split(/\r?\n/).filter(Boolean);
		const covered = sparsePaths.some((path) => relPath === path || relPath.startsWith(`${path}/`));
		if (target?.type === "tree" && !covered) {
			await withProgress(onProgress, `Adding ${relPath} to the checkout...`, () => git(["sparse-checkout", "add", relPath], dir, signal));
			sparsePaths = (await git(["sparse-checkout", "list"], dir, signal)).split(/\r?\n/).filter(Boolean);
		}
	}
	return { dir, sha, entries, fileCount, sparse, sparseReason: sparseReason || undefined, sparsePaths };
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

const GITHUB_CONTENT_PREVIEW_CHARS = 20_000;

function limitUtf8Text(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return { text, truncated: false };
	return {
		text: bytes.subarray(0, Math.max(1, maxBytes)).toString("utf8"),
		truncated: true,
	};
}

function boundFormattedPayload(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bounded = limitUtf8Text(text, maxBytes);
	return bounded.truncated
		? {
				text: `${bounded.text}\n\n[GitHub payload truncated at ${maxBytes.toLocaleString()} bytes]`,
				truncated: true,
			}
		: bounded;
}

function formatUser(user: any): string {
	return user?.login ? `@${user.login}` : "unknown";
}

const GITHUB_PATCH_PREVIEW_CHARS = 80_000;

function formatChangedFiles(files: any[]): string[] {
	const fileList = files.map((file) =>
		`- ${file.status || "modified"} ${file.filename || "(unnamed)"} (+${file.additions ?? "?"}/-${file.deletions ?? "?"})`,
	);
	const patches = files
		.filter((file) => typeof file?.patch === "string" && file.patch)
		.map((file) => `### ${file.filename}\n\n\`\`\`diff\n${file.patch}\n\`\`\``)
		.join("\n\n");
	const truncated = patches.length > GITHUB_PATCH_PREVIEW_CHARS;
	const patchPreview = truncated ? patches.slice(0, GITHUB_PATCH_PREVIEW_CHARS) : patches;

	return [
		"Files:",
		...fileList,
		patchPreview ? "\nDiff:" : "",
		patchPreview,
		truncated
			? `\n[Diff preview truncated at ${GITHUB_PATCH_PREVIEW_CHARS.toLocaleString()} characters; fetch the commit or pull request .patch URL for the complete patch.]`
			: "",
	].filter(Boolean);
}

export function formatGitHubCommitPreview(owner: string, repo: string, commit: any, url: string): string {
	const files = Array.isArray(commit?.files) ? commit.files : [];
	const message = String(commit?.commit?.message || "(no commit message)");
	const author = formatUser(commit?.author);
	const authorName = commit?.commit?.author?.name;
	const authorLabel = author === "unknown" ? authorName || author : authorName ? `${author} (${authorName})` : author;
	return [
		`Commit: ${owner}/${repo}@${commit?.sha || "unknown"}`,
		`Title: ${message.split(/\r?\n/, 1)[0]}`,
		`Author: ${authorLabel}`,
		commit?.commit?.author?.date ? `Date: ${commit.commit.author.date}` : "",
		`URL: ${commit?.html_url || url}`,
		Array.isArray(commit?.parents) && commit.parents.length
			? `Parent${commit.parents.length === 1 ? "" : "s"}: ${commit.parents.map((parent: any) => parent?.sha).filter(Boolean).join(", ")}`
			: "",
		commit?.stats ? `Changes: +${commit.stats.additions ?? "?"}/-${commit.stats.deletions ?? "?"} across ${files.length} file${files.length === 1 ? "" : "s"}` : `Changed files: ${files.length}`,
		"",
		"Message:",
		message,
		"",
		...formatChangedFiles(files),
	].filter((line) => line !== "").join("\n");
}

async function handleGitHubCommit(
	config: ExtensionConfig,
	parsed: Extract<ParsedGitHubUrl, { mode: "commit" }>,
	url: string,
	signal?: AbortSignal,
): Promise<GitHubResolution> {
	const commit: any = await fetchGitHubJson(
		`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(parsed.ref)}?per_page=100`,
		config.maxTextResponseBytes,
		signal,
	);
	const formatted = formatGitHubCommitPreview(parsed.owner, parsed.repo, commit, url);
	const bounded = boundFormattedPayload(formatted, config.maxTextResponseBytes);
	const preview = bounded.text;
	return {
		kind: "github",
		url,
		owner: parsed.owner,
		repo: parsed.repo,
		strategy: "github-api",
		ref: commit?.sha || parsed.ref,
		preview,
		content: preview,
		contentKind: "api",
		contentTruncated: bounded.truncated || preview.includes("Diff preview truncated"),
	};
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
		const formatted = [
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
			...formatChangedFiles(files),
		].join("\n");
		const bounded = boundFormattedPayload(formatted, config.maxTextResponseBytes);
		const preview = bounded.text;
		return {
			kind: "github",
			url,
			owner: parsed.owner,
			repo: parsed.repo,
			strategy: "github-api",
			preview,
			content: preview,
			contentKind: "api",
			contentTruncated: bounded.truncated || preview.includes("Diff preview truncated"),
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
	const formatted = [
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
	const bounded = boundFormattedPayload(formatted, config.maxTextResponseBytes);
	const preview = bounded.text;
	return {
		kind: "github",
		url,
		owner: parsed.owner,
		repo: parsed.repo,
		strategy: "github-api",
		preview,
		content: preview,
		contentKind: "api",
		contentTruncated: bounded.truncated,
	};
}

export type CheckoutPreviewInput = {
	owner: string;
	repo: string;
	ref: string;
	sha: string;
	relPath: string;
	dir: string;
	localPath: string;
	fileCount: number;
	sparse: boolean;
	sparseReason?: string;
	sparsePaths: string[];
	fileListPath?: string;
	listing?: string[];
	fileText?: string;
};

export function formatCheckoutPreview(input: CheckoutPreviewInput): string {
	const { owner, repo, ref } = input;
	const isFile = input.fileText !== undefined;
	const onDisk = existsSync(input.localPath);
	const guidance = input.sparse
		? [
				`On disk: root files${input.sparsePaths.length ? `, ${input.sparsePaths.join(", ")}` : ""}`,
				"",
				"Only some folders of this repository are on disk. Explore them with read, rg and ls in the local checkout.",
				`To add a folder, call fetch_url with its tree URL, for example https://github.com/${owner}/${repo}/tree/${ref}/<folder>.`,
				input.fileListPath ? `The file list of the whole repository is in ${input.fileListPath}` : undefined,
			]
		: [
				"",
				"The whole repository is on disk. Explore it with read, rg and ls in the local checkout.",
				"Do not call fetch_url for other files or folders of this repository.",
			];
	return [
		`Repository: ${owner}/${repo}`,
		`Ref: ${ref} (${input.sha.slice(0, 12)})`,
		`Local checkout: ${input.dir}`,
		input.relPath ? `${isFile ? "File" : "Path"}: ${input.relPath}` : undefined,
		input.relPath && onDisk ? `Local path: ${input.localPath}` : undefined,
		`Checkout: ${input.sparse ? "sparse" : "full"}, ${input.fileCount.toLocaleString("en-US")} files${input.sparseReason ? ` (${input.sparseReason})` : ""}`,
		...guidance,
		"",
		isFile ? "Contents:" : `Listing of ${input.relPath || "/"}:`,
		...(isFile ? [input.fileText || "(empty file)"] : input.listing || []),
	].filter((line) => line !== undefined).join("\n");
}

export async function handleGitHubUrl(config: ExtensionConfig, url: string, onProgress?: ProgressReporter, signal?: AbortSignal): Promise<GitHubResolution> {
	const parsed = parseGitHubUrl(url);
	if (!parsed) throw new Error("Not a GitHub URL");
	if (parsed.mode === "commit") return handleGitHubCommit(config, parsed, url, signal);
	if (parsed.mode === "pull" || parsed.mode === "issue") return handleGitHubPullOrIssue(config, parsed, url, signal);
	if (parsed.mode === "raw" || parsed.mode === "blob") {
		throw new Error("Raw and blob GitHub URLs must be routed through the direct HTTP fetcher");
	}

	const source = parsed as Extract<ParsedGitHubUrl, { mode: "root" | "tree" }>;
	const { owner, repo } = source;
	const { ref, relPath } = await resolveRemoteRefAndPath(owner, repo, source.mode, source.rest, signal);
	return await withRepoLock(config, owner, repo, onProgress, signal, async () => {
		const checkout = await ensureCheckout(config, owner, repo, ref, relPath, signal, onProgress);
		const localPath = relPath ? join(checkout.dir, ...relPath.split("/")) : checkout.dir;
		const isFile = checkout.entries.some((entry) => entry.path === relPath && entry.type === "blob");

		let fileListPath: string | undefined;
		if (checkout.sparse) {
			fileListPath = join(config.githubCacheDir, owner, repo, `${checkoutDirName(ref)}.files.txt`);
			const files = checkout.entries.filter((entry) => entry.type === "blob").map((entry) => entry.path);
			await writeFile(fileListPath, `${files.join("\n")}\n`, "utf8");
		}

		let content = "";
		let fileText: string | undefined;
		let contentTruncated = false;
		if (isFile) {
			onProgress?.(`Reading ${relPath}...`);
			// `git show` also works for files outside a sparse checkout.
			const text = await git(["show", `${checkout.sha}:${relPath}`], checkout.dir, signal, false);
			const bounded = limitUtf8Text(text, config.maxTextResponseBytes);
			content = bounded.text;
			contentTruncated = bounded.truncated;
			fileText = text.length > GITHUB_CONTENT_PREVIEW_CHARS
				? `${text.slice(0, GITHUB_CONTENT_PREVIEW_CHARS)}\n\n[preview truncated at ${GITHUB_CONTENT_PREVIEW_CHARS.toLocaleString("en-US")} characters; read the local file for the rest]`
				: text;
		}

		const preview = formatCheckoutPreview({
			owner,
			repo,
			ref,
			sha: checkout.sha,
			relPath,
			dir: checkout.dir,
			localPath,
			fileCount: checkout.fileCount,
			sparse: checkout.sparse,
			sparseReason: checkout.sparseReason,
			sparsePaths: checkout.sparsePaths,
			fileListPath,
			listing: isFile ? undefined : formatListing(checkout.entries, relPath),
			fileText,
		});

		return {
			kind: "github",
			url,
			owner,
			repo,
			strategy: "github-checkout",
			repoDir: checkout.dir,
			ref,
			requestedPath: relPath || undefined,
			localPath,
			preview,
			content: isFile ? content : preview,
			contentKind: isFile ? "text" : "listing",
			contentTruncated,
		};
	});
}
