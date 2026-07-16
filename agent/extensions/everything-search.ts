import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { constants, createWriteStream, type WriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

type EverythingSearchInput = {
	query: string;
	scope_path?: string;
	children_only?: boolean;
	search_full_path?: boolean;
	match_path?: boolean;
	count?: number;
	offset?: number;
	dump_to_file?: boolean;
	sort?: "name" | "path" | "size" | "date_modified" | "date_created";
	ascending?: boolean;
	regex?: boolean;
	case_sensitive?: boolean;
	whole_word?: boolean;
};

type EverythingItem = {
	path?: string;
	name?: string;
	type?: "file" | "folder" | string;
	size?: string | number;
	date_modified?: string;
};

type EverythingResponse = {
	totalResults?: number;
	results?: EverythingItem[];
};

type EverythingHttpCapabilities = {
	pluginsIniPath?: string;
	allowDiskAccess?: boolean;
	allowQueryAccess?: boolean;
};

type PreparedEverythingSearch = {
	query: string;
	searchFullPath: boolean;
	warnings: string[];
	originalQuery: string;
	scopePath?: string;
	childrenOnly: boolean;
};

const EVERYTHING_HOST = process.env.EVERYTHING_HOST || "localhost";
const EVERYTHING_PORT = process.env.EVERYTHING_PORT || "54367";
const EVERYTHING_MAX_RESULTS = Math.max(1, Number(process.env.EVERYTHING_MAX_RESULTS) || 255);
const EVERYTHING_INSTALL_CHECK_TIMEOUT_MS = Math.max(25, Number(process.env.EVERYTHING_INSTALL_CHECK_TIMEOUT_MS) || 120);

const EVERYTHING_SEARCH_SCHEMA = Type.Object({
	query: Type.String({
		description: "Everything query text. Supports extensions, dates, sizes, content search, wildcards, boolean operators, grouping, and phrases.",
	}),
	scope_path: Type.Optional(
		Type.String({
			description: "Optional folder scope. Limits results to this folder tree.",
		}),
	),
	children_only: Type.Optional(
		Type.Boolean({
			description: "When used with scope_path, return only direct children instead of the full subtree.",
		}),
	),
	search_full_path: Type.Optional(
		Type.Boolean({
			description: "Match query terms against full path plus filename text, not just filename text.",
		}),
	),
	match_path: Type.Optional(
		Type.Boolean({
			description: "Deprecated alias for search_full_path.",
		}),
	),
	count: Type.Optional(
		Type.Number({
			description: `Maximum results to return. In normal mode, default 50 and hard cap ${EVERYTHING_MAX_RESULTS}. With dump_to_file, maximum results to write; omit to dump all results after offset.`,
			minimum: 1,
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Result offset for pagination, or start offset when dump_to_file is enabled.",
			minimum: 0,
		}),
	),
	dump_to_file: Type.Optional(
		Type.Boolean({
			description: "Write matching results to a randomly named JSONL file in the OS temp directory instead of returning result lines in context.",
		}),
	),
	sort: Type.Optional(StringEnum(["name", "path", "size", "date_modified", "date_created"] as const)),
	ascending: Type.Optional(Type.Boolean()),
	regex: Type.Optional(Type.Boolean()),
	case_sensitive: Type.Optional(Type.Boolean()),
	whole_word: Type.Optional(Type.Boolean()),
});

function parseEnvFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function isLocalEverythingHost(): boolean {
	const normalized = EVERYTHING_HOST.trim().toLowerCase();
	return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(normalized);
}

async function pathExists(path: string | undefined): Promise<boolean> {
	if (!path) return false;
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function runProbe(command: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: EVERYTHING_INSTALL_CHECK_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolve(!error && stdout.trim().length > 0);
		});
	});
}

async function isEverythingHttpReachable(): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), EVERYTHING_INSTALL_CHECK_TIMEOUT_MS);
	try {
		const url = new URL(`http://${EVERYTHING_HOST}:${EVERYTHING_PORT}/`);
		url.searchParams.set("json", "1");
		url.searchParams.set("search", "");
		url.searchParams.set("count", "1");
		const response = await fetch(url, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function hasEverythingExecutableInCommonLocations(): Promise<boolean> {
	const candidates = [
		process.env.EVERYTHING_EXE,
		process.env.EVERYTHING_PATH,
		process.env.ProgramFiles ? join(process.env.ProgramFiles, "Everything", "Everything.exe") : undefined,
		process.env.ProgramFiles ? join(process.env.ProgramFiles, "Everything 1.5a", "Everything64.exe") : undefined,
		process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Everything", "Everything.exe") : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Everything", "Everything.exe") : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Everything", "Everything.exe") : undefined,
	].filter((path): path is string => Boolean(path));

	return (await Promise.all(candidates.map(pathExists))).some(Boolean);
}

async function hasEverythingRegistryEntry(): Promise<boolean> {
	const keys = [
		"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe",
		"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe",
		"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything",
		"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything",
		"HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything",
	];

	return (await Promise.all(keys.map((key) => runProbe("reg.exe", ["query", key])))).some(Boolean);
}

async function shouldRegisterEverythingSearch(): Promise<boolean> {
	const explicit = parseEnvFlag(process.env.EVERYTHING_SEARCH_EXTENSION_ENABLED ?? process.env.EVERYTHING_EXTENSION_ENABLED);
	if (explicit !== undefined) return explicit;

	if (await isEverythingHttpReachable()) return true;
	if (!isLocalEverythingHost() || process.platform !== "win32") return false;
	if (await hasEverythingExecutableInCommonLocations()) return true;
	if (await hasEverythingRegistryEntry()) return true;
	if (await runProbe("where.exe", ["Everything.exe"])) return true;

	return false;
}

function filetimeToISO(filetime: string | number | undefined): string | undefined {
	if (filetime === undefined) return undefined;
	const raw = typeof filetime === "number" ? BigInt(filetime) : BigInt(filetime);
	const FILETIME_EPOCH_DIFF = 11644473600000n;
	const FILETIME_TICKS_PER_MS = 10000n;
	const ms = raw / FILETIME_TICKS_PER_MS - FILETIME_EPOCH_DIFF;
	return new Date(Number(ms)).toISOString();
}

function formatSize(size: string | number | undefined): string | undefined {
	if (size === undefined) return undefined;
	const n = typeof size === "number" ? size : Number(size);
	if (!Number.isFinite(n)) return undefined;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = ((ms % 60000) / 1000).toFixed(1);
	return `${minutes}m ${seconds}s`;
}

function buildFullPath(item: EverythingItem): string {
	return item.name ? `${item.path || ""}\\${item.name}` : item.path || "";
}

function buildResultLine(item: EverythingItem): string {
	const parts = [buildFullPath(item)];
	if (item.type === "folder") {
		parts.push("[folder]");
	} else {
		const size = formatSize(item.size);
		if (size) parts.push(size);
	}
	const modified = filetimeToISO(item.date_modified);
	if (modified) parts.push(modified);
	return parts.join("  ");
}

function buildDumpRecord(item: EverythingItem): Record<string, unknown> {
	return {
		fullPath: buildFullPath(item),
		path: item.path,
		name: item.name,
		type: item.type,
		size: item.size,
		date_modified: item.date_modified,
		date_modified_iso: filetimeToISO(item.date_modified),
	};
}

function formatSearchOptions(params: EverythingSearchInput | undefined): string {
	if (!params) return "";
	const searchFullPath = params.search_full_path ?? params.match_path;
	const parts = [
		params.scope_path ? `scope=${params.scope_path}` : undefined,
		params.children_only ? "children-only" : undefined,
		searchFullPath ? "search-full-path" : undefined,
		params.count !== undefined ? `count=${params.count}` : undefined,
		params.offset !== undefined ? `offset=${params.offset}` : undefined,
		params.dump_to_file ? "dump-to-file" : undefined,
		params.sort ? `sort=${params.sort}` : undefined,
		params.ascending === false ? "descending" : undefined,
		params.regex ? "regex" : undefined,
		params.case_sensitive ? "case-sensitive" : undefined,
		params.whole_word ? "whole-word" : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.join("  ");
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text || "")
		.join("\n")
		.trim();
}

function quoteEverything(text: string): string {
	return `"${text.replace(/"/g, 'quot:')}"`;
}

function normalizePathForScope(path: string): string {
	return path.replace(/^@/, "").replace(/[\\/]+$/, "");
}

function normalizeSearchInput(params: EverythingSearchInput): PreparedEverythingSearch {
	const originalQuery = params.query.trim();
	const scopePath = params.scope_path?.trim();
	const childrenOnly = Boolean(params.children_only && scopePath);
	const searchFullPath = Boolean(params.search_full_path ?? params.match_path);
	const warnings: string[] = [];

	let scopePrefix = "";
	if (scopePath) {
		const normalizedScope = normalizePathForScope(scopePath);
		scopePrefix = childrenOnly ? `parent:${quoteEverything(normalizedScope)}` : quoteEverything(`${normalizedScope}\\`);
	}

	const query = [scopePrefix, originalQuery].filter(Boolean).join(" ").trim();
	if (/\|/.test(originalQuery) && /\s/.test(originalQuery) && !/[<>]/.test(originalQuery)) {
		warnings.push("Query mixes | with spaces without <...> grouping. In Everything, | binds tighter than space.");
	}

	return {
		query,
		searchFullPath,
		warnings,
		originalQuery,
		scopePath: scopePath || undefined,
		childrenOnly,
	};
}

function queryRequiresDiskAccess(query: string): boolean {
	return /(^|\s)(content|include-filelist):/i.test(query);
}

function queryRequiresQueryAccess(query: string): boolean {
	return /(^|\s)(is-open|online|runcount):/i.test(query);
}

async function findEverythingPluginsIni(): Promise<string | undefined> {
	const appData = process.env.APPDATA;
	if (!appData) return undefined;

	const everythingDir = join(appData, "Everything");
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(everythingDir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	const candidates = entries
		.filter((entry) => entry.isFile() && /^Plugins-.*\.ini$/i.test(entry.name))
		.map((entry) => join(everythingDir, entry.name));
	if (candidates.length === 0) return undefined;

	const withStats = await Promise.all(
		candidates.map(async (path) => {
			try {
				return { path, mtimeMs: (await stat(path)).mtimeMs };
			} catch {
				return { path, mtimeMs: -1 };
			}
		}),
	);

	withStats.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
	return withStats[0]?.path;
}

function parseIniBoolean(text: string, key: string): boolean | undefined {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.match(new RegExp(`^${escapedKey}=(\\d+)\\s*$`, "im"));
	if (!match) return undefined;
	return match[1] !== "0";
}

async function getEverythingHttpCapabilities(): Promise<EverythingHttpCapabilities> {
	const pluginsIniPath = await findEverythingPluginsIni();
	if (!pluginsIniPath) return {};

	try {
		const text = await readFile(pluginsIniPath, "utf8");
		return {
			pluginsIniPath,
			allowDiskAccess: parseIniBoolean(text, "allow_disk_access"),
			allowQueryAccess: parseIniBoolean(text, "allow_query_access"),
		};
	} catch {
		return { pluginsIniPath };
	}
}

type EverythingPage = {
	totalResults: number;
	results: EverythingItem[];
	elapsedMs: number;
};

function normalizeOffset(value: number | undefined): number {
	return Math.max(0, Math.floor(value ?? 0));
}

function normalizeContextCount(value: number | undefined): number {
	return Math.min(Math.max(1, Math.floor(value ?? 50)), EVERYTHING_MAX_RESULTS);
}

function normalizeDumpLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const limit = Math.floor(value);
	return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function buildEverythingUrl(params: EverythingSearchInput, prepared: PreparedEverythingSearch, count: number, offset: number): URL {
	const url = new URL(`http://${EVERYTHING_HOST}:${EVERYTHING_PORT}/`);
	url.searchParams.set("search", prepared.query);
	url.searchParams.set("json", "1");
	url.searchParams.set("count", String(count));
	url.searchParams.set("offset", String(offset));
	url.searchParams.set("path_column", "1");
	url.searchParams.set("size_column", "1");
	url.searchParams.set("date_modified_column", "1");
	url.searchParams.set("sort", params.sort ?? "name");
	url.searchParams.set("ascending", params.ascending === false ? "0" : "1");
	if (params.regex) url.searchParams.set("regex", "1");
	if (params.case_sensitive) url.searchParams.set("case", "1");
	if (params.whole_word) url.searchParams.set("wholeword", "1");
	if (prepared.searchFullPath) url.searchParams.set("path", "1");
	return url;
}

async function fetchEverythingPage(
	params: EverythingSearchInput,
	prepared: PreparedEverythingSearch,
	count: number,
	offset: number,
	signal: AbortSignal,
): Promise<EverythingPage> {
	const url = buildEverythingUrl(params, prepared, count, offset);
	const start = performance.now();
	let response: Response;
	try {
		response = await fetch(url, { signal });
	} catch {
		if (signal.aborted) throw new Error("Cancelled");
		throw new Error(
			`Cannot connect to Everything HTTP server at ${EVERYTHING_HOST}:${EVERYTHING_PORT}. ` +
			`Make sure Everything is running and HTTP Server is enabled.`,
		);
	}

	if (!response.ok) {
		throw new Error(`Everything HTTP server returned ${response.status}: ${response.statusText}`);
	}

	const data = (await response.json()) as EverythingResponse;
	return {
		totalResults: Math.max(0, Math.floor(data.totalResults ?? 0)),
		results: Array.isArray(data.results) ? data.results : [],
		elapsedMs: performance.now() - start,
	};
}

async function assertEverythingQueryAllowed(prepared: PreparedEverythingSearch): Promise<void> {
	const capabilities = await getEverythingHttpCapabilities();
	if (queryRequiresDiskAccess(prepared.query) && capabilities.allowDiskAccess === false) {
		const source = capabilities.pluginsIniPath ? ` in ${capabilities.pluginsIniPath}` : "";
		throw new Error(
			`Everything HTTP server has allow_disk_access=0${source}, so content: and include-filelist: searches are disabled over HTTP. ` +
			`Enable allow_disk_access=1 and restart Everything.`,
		);
	}
	if (queryRequiresQueryAccess(prepared.query) && capabilities.allowQueryAccess === false) {
		const source = capabilities.pluginsIniPath ? ` in ${capabilities.pluginsIniPath}` : "";
		throw new Error(
			`Everything HTTP server has allow_query_access=0${source}, so is-open:, online:, and runcount: searches are disabled over HTTP. ` +
			`Enable allow_query_access=1 and restart Everything.`,
		);
	}
}

async function waitForDrain(stream: WriteStream): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error: unknown) => {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}

async function writeJsonLine(stream: WriteStream, value: unknown, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new Error("Cancelled");
	if (!stream.write(`${JSON.stringify(value)}\n`)) await waitForDrain(stream);
	if (signal.aborted) throw new Error("Cancelled");
}

function buildBaseDetails(prepared: PreparedEverythingSearch, offset: number): Record<string, unknown> {
	return {
		query: prepared.query,
		originalQuery: prepared.originalQuery,
		scope_path: prepared.scopePath,
		children_only: prepared.childrenOnly,
		search_full_path: prepared.searchFullPath,
		warnings: prepared.warnings,
		offset,
		endpoint: `http://${EVERYTHING_HOST}:${EVERYTHING_PORT}/`,
	};
}

async function dumpEverythingResults(
	params: EverythingSearchInput,
	prepared: PreparedEverythingSearch,
	signal: AbortSignal,
): Promise<{ summary: string; details: Record<string, unknown> }> {
	const outputPath = join(tmpdir(), `pi-everything-search-${randomUUID()}.jsonl`);
	const stream = createWriteStream(outputPath, { encoding: "utf8" });
	const start = performance.now();
	const initialOffset = normalizeOffset(params.offset);
	const limit = normalizeDumpLimit(params.count);
	let offset = initialOffset;
	let remaining = limit;
	let totalResults = 0;
	let writtenResults = 0;

	try {
		while (remaining === undefined || remaining > 0) {
			const pageCount = Math.min(EVERYTHING_MAX_RESULTS, remaining ?? EVERYTHING_MAX_RESULTS);
			const page = await fetchEverythingPage(params, prepared, pageCount, offset, signal);
			totalResults = page.totalResults;

			if (page.results.length === 0) break;
			for (const item of page.results) {
				await writeJsonLine(stream, buildDumpRecord(item), signal);
			}

			writtenResults += page.results.length;
			offset += page.results.length;
			if (remaining !== undefined) remaining -= page.results.length;
			if (offset >= totalResults || page.results.length < pageCount) break;
		}

		stream.end();
		await finished(stream);
	} catch (error) {
		stream.destroy();
		throw error;
	}

	const elapsed = performance.now() - start;
	const startIndex = writtenResults > 0 ? initialOffset + 1 : 0;
	const endIndex = writtenResults > 0 ? initialOffset + writtenResults : 0;
	const range = writtenResults > 0 ? ` (showing ${startIndex}-${endIndex})` : "";
	const lines = [`Found ${totalResults} results. Dumped ${writtenResults} results${range} to ${outputPath} in ${formatDuration(elapsed)}`];
	if (prepared.warnings.length > 0) {
		lines.push("");
		for (const warning of prepared.warnings) lines.push(`Warning: ${warning}`);
	}
	lines.push("", "Format: JSONL, one result per line");

	return {
		summary: lines.join("\n"),
		details: {
			...buildBaseDetails(prepared, initialOffset),
			dump_to_file: true,
			output_path: outputPath,
			output_format: "jsonl",
			count: limit,
			totalResults,
			writtenResults,
			elapsedMs: Math.round(elapsed),
		},
	};
}

async function searchEverything(params: EverythingSearchInput, signal: AbortSignal): Promise<{ summary: string; details: Record<string, unknown> }> {
	const prepared = normalizeSearchInput(params);
	await assertEverythingQueryAllowed(prepared);
	if (params.dump_to_file) return dumpEverythingResults(params, prepared, signal);

	const count = normalizeContextCount(params.count);
	const offset = normalizeOffset(params.offset);
	const page = await fetchEverythingPage(params, prepared, count, offset, signal);
	const totalResults = page.totalResults;
	const results = page.results;
	const end = totalResults > 0 ? Math.min(offset + count, totalResults) : 0;

	const lines = [`Found ${totalResults} results (showing ${totalResults > 0 ? offset + 1 : 0}-${end}) in ${formatDuration(page.elapsedMs)}`];
	if (prepared.warnings.length > 0) {
		lines.push("");
		for (const warning of prepared.warnings) lines.push(`Warning: ${warning}`);
	}
	if (results.length > 0) {
		lines.push("");
		for (const item of results) lines.push(buildResultLine(item));
	}

	return {
		summary: lines.join("\n"),
		details: {
			...buildBaseDetails(prepared, offset),
			dump_to_file: false,
			count,
			totalResults,
			elapsedMs: Math.round(page.elapsedMs),
			results: results.map((item) => ({
				path: item.path,
				name: item.name,
				type: item.type,
				size: item.size,
				date_modified: item.date_modified,
			})),
		},
	};
}

export type { EverythingSearchInput };

export default async function (pi: ExtensionAPI) {
	if (!(await shouldRegisterEverythingSearch())) return;

	pi.registerTool({
		name: "everything_search",
		label: "Everything Search",
		description: "Search files and folders anywhere on this PC using Everything.",
		promptSnippet: "Search local files and folders with Everything",
		promptGuidelines: [
			"Use `everything_search` as the preferred option for very fast file and folder discovery, anywhere on the local PC, or scoped to a folder.",
			"Prefer `rg` over Everything's `content:` filter for searching file contents.",
			"`everything_search` query syntax: `space`=AND, `|`=OR, `<...>`=grouping, and `\"...\"`=exact phrase. If mixing `|` with spaces, use `<...>`.",
			"Use `scope_path` to limit results to a folder tree, `children_only` for direct children only, and `search_full_path` to match against full path+filename text.",
			"Use `ext:` to filter by extension; for example `ext:py`, `ext:ts;tsx`, or `ext:jpg;png`.",
			"Use `file:` or `folder:` to limit results to files only or folders only. Useful with filters such as `dm:today` or `size:>1mb`.",
			"Common `everything_search` filters: `dm:` for modified date, `dc:` for created date, `size:` for file size, `regex:` to enable regex, and `wholeword:` or `case:` when needed.",
			"Use `dump_to_file` to write matching results to a temp JSONL file instead of returning result lines in context; with dump_to_file, `count` limits how many results are written and `offset` chooses where to start.",
			"Use the tool options `count`, `offset`, `sort` (`name`, `path`, `size`, `date_modified`, `date_created`), and `ascending` to control result volume and ordering.",
		],
		renderCall(args, theme, context) {
			const currentArgs = (context.args as EverythingSearchInput | undefined) ?? (args as EverythingSearchInput | undefined);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = currentArgs?.query ?? "";
			const options = formatSearchOptions(currentArgs);
			let output = `${theme.fg("toolTitle", theme.bold("Everything Search"))}`;
			if (query) output += `  ${theme.fg("accent", query)}`;
			if (options) output += `  ${theme.fg("muted", options)}`;
			text.setText(output);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const body = getTextContent(result.content);
			const bodyLines = body ? body.split("\n") : [];
			const summaryLine = bodyLines[0] ?? "";
			const resultLines = bodyLines.slice(1).filter((line) => line.trim().length > 0);
			const previewLines = options.expanded ? resultLines : resultLines.slice(0, 10);
			let output = summaryLine ? theme.fg("muted", summaryLine) : "";
			if (previewLines.length > 0) {
				output += `\n\n${theme.fg("muted", previewLines.join("\n"))}`;
				if (!options.expanded && resultLines.length > previewLines.length) {
					output += `\n${theme.fg("muted", `... (${resultLines.length - previewLines.length} more lines, to expand)`)}`;
				}
			}
			text.setText(output);
			return text;
		},
		parameters: EVERYTHING_SEARCH_SCHEMA,
		async execute(_toolCallId, params, signal) {
			const result = await searchEverything(params as EverythingSearchInput, signal);
			return {
				content: [{ type: "text", text: result.summary }],
				details: result.details,
			};
		},
	});
}
