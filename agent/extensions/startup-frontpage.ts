/**
 * Startup Frontpage Extension
 *
 * Owns the visual startup header: branded Pi art and the linked-session family tree.
 * It deliberately contains no session-management commands.
 */

import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionHeader,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const HEADER_READ_BYTES = 64 * 1024;
const FILE_CONCURRENCY = 8;

export interface SessionFamilyNode {
	path: string;
	id: string;
	timestamp: string;
	parentPath?: string;
	name?: string;
	firstMessage?: string;
	messageCount?: number;
	modifiedAt?: number;
	/** Relative age captured when the session family is loaded; stable during rendering. */
	ageLabel?: string;
	children: SessionFamilyNode[];
}

interface SessionLabel {
	name?: string;
	firstMessage?: string;
	messageCount: number;
	modifiedAt?: number;
}

interface LineageRow {
	content: string;
	count: string;
	age: string;
}

const TRAILING_LABEL_GAP = 4;

function canonicalPath(path: string): string {
	const normalized = resolve(path).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function cleanLabel(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((part): part is { type: "text"; text: string } => (
			typeof part === "object"
			&& part !== null
			&& (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string"
		))
		.map((part) => part.text)
		.join(" ");
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const worker = async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index]!);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

async function readHeader(path: string): Promise<SessionHeader | undefined> {
	let file;
	try {
		file = await open(path, "r");
		const buffer = Buffer.alloc(HEADER_READ_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
		if (!firstLine) return undefined;

		const parsed = JSON.parse(firstLine) as Partial<SessionHeader>;
		if (parsed.type !== "session" || typeof parsed.id !== "string" || typeof parsed.timestamp !== "string") {
			return undefined;
		}
		return parsed as SessionHeader;
	} catch {
		return undefined;
	} finally {
		try {
			await file?.close();
		} catch {
			// Ignore close failures after the header read has already completed.
		}
	}
}

async function readSessionLabel(path: string): Promise<SessionLabel> {
	let name: string | undefined;
	let firstMessage: string | undefined;
	let messageCount = 0;
	let modifiedAt: number | undefined;

	try {
		const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.includes('"type":"session_info"') && !line.includes('"type":"message"')) {
				continue;
			}

			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry?.type === "session_info") {
				name = typeof entry.name === "string" ? cleanLabel(entry.name) || undefined : undefined;
			} else if (entry?.type === "message") {
				messageCount++;
				const role = entry.message?.role;
				if (role === "user" || role === "assistant") {
					const timestamp = typeof entry.message?.timestamp === "number"
						? entry.message.timestamp
						: Date.parse(entry.timestamp);
					if (Number.isFinite(timestamp)) modifiedAt = Math.max(modifiedAt ?? 0, timestamp);
				}
				if (role === "user" && !firstMessage) {
					firstMessage = cleanLabel(messageText(entry.message.content)) || undefined;
				}
			}
		}
	} catch {
		// A missing or concurrently removed family member can still be shown by ID.
	}

	return { name, firstMessage, messageCount, modifiedAt };
}

function nodeFromHeader(path: string, header: SessionHeader): SessionFamilyNode {
	return {
		path,
		id: header.id,
		timestamp: header.timestamp,
		parentPath: header.parentSession,
		children: [],
	};
}

/** Build the connected parent/descendant tree containing currentPath. */
export function buildSessionFamily(
	nodes: SessionFamilyNode[],
	currentPath: string,
): SessionFamilyNode | undefined {
	const byPath = new Map(nodes.map((node) => [canonicalPath(node.path), node]));
	const current = byPath.get(canonicalPath(currentPath));
	if (!current) return undefined;

	for (const node of nodes) node.children = [];
	for (const node of nodes) {
		if (!node.parentPath) continue;
		const parent = byPath.get(canonicalPath(node.parentPath));
		if (parent && parent !== node) parent.children.push(node);
	}

	const seen = new Set<SessionFamilyNode>();
	let root = current;
	while (root.parentPath && !seen.has(root)) {
		seen.add(root);
		const parent = byPath.get(canonicalPath(root.parentPath));
		if (!parent || seen.has(parent)) break;
		root = parent;
	}

	const sortChildren = (node: SessionFamilyNode, visited: Set<SessionFamilyNode>) => {
		if (visited.has(node)) return;
		visited.add(node);
		node.children.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
		for (const child of node.children) sortChildren(child, visited);
	};
	sortChildren(root, new Set());
	return root;
}

async function loadSessionFamily(ctx: ExtensionContext): Promise<{
	root: SessionFamilyNode;
	currentPath: string;
} | undefined> {
	const currentPath = ctx.sessionManager.getSessionFile();
	if (!currentPath) return undefined;

	let filenames: string[];
	try {
		filenames = (await readdir(ctx.sessionManager.getSessionDir())).filter((name) => name.endsWith(".jsonl"));
	} catch {
		filenames = [];
	}

	const sessionDir = ctx.sessionManager.getSessionDir();
	const paths = filenames.map((name) => resolve(sessionDir, name));
	const headers = await mapWithConcurrency(paths, FILE_CONCURRENCY, async (path) => ({ path, header: await readHeader(path) }));
	const nodes = headers
		.filter((item): item is { path: string; header: SessionHeader } => Boolean(item.header))
		.map((item) => nodeFromHeader(item.path, item.header));

	// A brand-new persistent session may not have reached the directory listing yet.
	if (!nodes.some((node) => canonicalPath(node.path) === canonicalPath(currentPath))) {
		const currentHeader = ctx.sessionManager.getHeader();
		if (currentHeader) nodes.push(nodeFromHeader(currentPath, currentHeader));
	}

	const root = buildSessionFamily(nodes, currentPath);
	if (!root) return undefined;

	const family: SessionFamilyNode[] = [];
	const collect = (node: SessionFamilyNode, visited: Set<SessionFamilyNode>) => {
		if (visited.has(node)) return;
		visited.add(node);
		family.push(node);
		for (const child of node.children) collect(child, visited);
	};
	collect(root, new Set());

	const ageReferenceMs = Date.now();
	const labels = await mapWithConcurrency(family, FILE_CONCURRENCY, (node) => readSessionLabel(node.path));
	for (let i = 0; i < family.length; i++) {
		family[i]!.name = labels[i]!.name;
		family[i]!.firstMessage = labels[i]!.firstMessage;
		family[i]!.messageCount = labels[i]!.messageCount;
		family[i]!.modifiedAt = labels[i]!.modifiedAt;
		const createdAt = Date.parse(family[i]!.timestamp);
		const ageTimestamp = labels[i]!.modifiedAt ?? (Number.isFinite(createdAt) ? createdAt : ageReferenceMs);
		family[i]!.ageLabel = formatSessionAge(ageTimestamp, ageReferenceMs);
	}

	// The in-memory manager is authoritative if /name just changed but the file is still flushing.
	const current = family.find((node) => canonicalPath(node.path) === canonicalPath(currentPath));
	if (current) current.name = ctx.sessionManager.getSessionName();

	return { root, currentPath };
}

function sessionDisplayName(node: SessionFamilyNode): string {
	return node.name || node.firstMessage || "(no messages)";
}

function formatSessionAge(timestamp: number, nowMs: number): string {
	const diffMs = nowMs - timestamp;
	const minutes = Math.floor(diffMs / 60_000);
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function hierarchyLines(root: SessionFamilyNode): Array<{ prefix: string; node: SessionFamilyNode }> {
	const lines: Array<{ prefix: string; node: SessionFamilyNode }> = [];
	const visited = new Set<SessionFamilyNode>();

	const walk = (node: SessionFamilyNode, indent: string, isLast: boolean, isRoot: boolean) => {
		if (visited.has(node)) return;
		visited.add(node);
		lines.push({ prefix: isRoot ? "" : `${indent}${isLast ? "└─ " : "├─ "}`, node });
		const childIndent = isRoot ? "" : `${indent}${isLast ? "   " : "│  "}`;
		node.children.forEach((child, index) => walk(child, childIndent, index === node.children.length - 1, false));
	};

	walk(root, "", true, true);
	return lines;
}

function styledHierarchyLines(
	root: SessionFamilyNode,
	currentPath: string,
	theme: Theme,
): LineageRow[] {
	return hierarchyLines(root).map(({ prefix, node }) => {
		const current = canonicalPath(node.path) === canonicalPath(currentPath);
		const label = sessionDisplayName(node);
		const styledLabel = current
			? theme.bold(theme.fg("accent", label))
			: node.name ? theme.fg("warning", label) : label;
		const guid = theme.fg("toolDiffAdded", node.id.slice(-6));
		const currentMarker = current ? theme.fg("dim", " <- you are here") : "";
		const age = node.ageLabel ?? "?";
		return {
			content: `${theme.fg("dim", prefix)}${guid}  ${styledLabel}${currentMarker}`,
			count: String(node.messageCount ?? 0),
			age,
		};
	});
}

function formatLineageRows(rows: LineageRow[], width: number, theme: Theme): string[] {
	const countWidth = Math.max(...rows.map((row) => visibleWidth(row.count)));
	const ageWidth = Math.max(...rows.map((row) => visibleWidth(row.age)));
	const metadata = rows.map((row) => theme.fg(
		"dim",
		`${row.count.padStart(countWidth)} ${row.age.padStart(ageWidth)}`,
	));
	const metadataWidth = Math.max(...metadata.map(visibleWidth));
	const widestContent = Math.max(...rows.map((row) => visibleWidth(row.content)));
	// Keep the trailing labels close to the widest session line instead of
	// pinning them to the far edge of a wide terminal.
	const contentWidth = Math.max(
		1,
		Math.min(widestContent, width - metadataWidth - TRAILING_LABEL_GAP),
	);

	return rows.map((row, index) => {
		const content = truncateToWidth(row.content, contentWidth, "…");
		const spacing = " ".repeat(
			Math.max(TRAILING_LABEL_GAP, contentWidth - visibleWidth(content) + TRAILING_LABEL_GAP),
		);
		return `${content}${spacing}${metadata[index]!}`;
	});
}

function brandLines(theme: Theme): string[] {
	const art = [
		"   __ ____",
		"  | _ \\_ _|",
		"  |  _/| |",
		"  |_| |___|",
	];

	return [
		...art.map((line) => theme.bold(theme.fg("accent", line))),
		theme.fg("dim", `  v${VERSION}`),
	];
}

function sideBySideFrontpage(
	root: SessionFamilyNode,
	currentPath: string,
	width: number,
	theme: Theme,
): string[] {
	const logo = brandLines(theme);
	const lineageRows = styledHierarchyLines(root, currentPath, theme);
	const logoWidth = Math.max(...logo.map(visibleWidth));
	const separatorWidth = 5; // two spaces, the rule, then two spaces
	const lineageWidth = width - 1 - logoWidth - separatorWidth;

	// Keep narrow terminals usable even though the normal presentation is side-by-side.
	if (lineageWidth < 12) {
		const stackedWidth = Math.max(1, width - 1);
		return [
			...logo,
			theme.fg("dim", "─".repeat(stackedWidth)),
			...formatLineageRows(lineageRows, stackedWidth, theme),
		];
	}

	const lineage = formatLineageRows(lineageRows, lineageWidth, theme);
	const height = Math.max(logo.length, lineage.length);
	const logoTop = Math.floor((height - logo.length) / 2);
	const lineageTop = Math.floor((height - lineage.length) / 2);
	const separator = theme.fg("dim", "│");
	const lines: string[] = [];

	for (let row = 0; row < height; row++) {
		const logoLine = logo[row - logoTop] ?? "";
		const lineageLine = lineage[row - lineageTop] ?? "";
		const logoPadding = " ".repeat(Math.max(0, logoWidth - visibleWidth(logoLine)));
		const clippedLineage = truncateToWidth(lineageLine, lineageWidth, "…");
		lines.push(`${logoLine}${logoPadding}  ${separator}  ${clippedLineage}`);
	}

	return lines;
}

function setSessionHeader(
	ctx: ExtensionContext,
	root: SessionFamilyNode | undefined,
	currentPath: string | undefined,
): void {
	ctx.ui.setHeader((_tui, theme) => {
		return {
				render(width: number): string[] {
					const lines = root && currentPath
						? sideBySideFrontpage(root, currentPath, width, theme)
						: brandLines(theme);
					lines.push("");

					return lines.map((line) => truncateToWidth(` ${line}`, width, "…"));
			},
			invalidate() {},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let headerGeneration = 0;
	let loadedFamily: { root: SessionFamilyNode; currentPath: string } | undefined;

	const setLoadedSessionName = (ctx: ExtensionContext): boolean => {
		if (!loadedFamily) return false;
		const current = hierarchyLines(loadedFamily.root)
			.map(({ node }) => node)
			.find((node) => canonicalPath(node.path) === canonicalPath(loadedFamily!.currentPath));
		if (!current) return false;

		const nextName = ctx.sessionManager.getSessionName();
		if (current.name === nextName) return false;
		current.name = nextName;
		return true;
	};

	const refreshHeader = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const generation = ++headerGeneration;

		// Show the brand immediately, then add the disk-backed family tree.
		setSessionHeader(ctx, undefined, undefined);
		const family = await loadSessionFamily(ctx);
		if (generation !== headerGeneration) return;
		loadedFamily = family;
		setSessionHeader(ctx, family?.root, family?.currentPath);
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshHeader(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		// Session-info changes are also emitted by some session-manager paths
		// while the transcript is being updated. Do not reload the whole family
		// here: doing so recomputes every relative age from Date.now() and makes
		// the startup header change once per minute. Only the current session's
		// display name can have changed for this event.
		if (setLoadedSessionName(ctx)) {
			setSessionHeader(ctx, loadedFamily?.root, loadedFamily?.currentPath);
		}
	});

	pi.on("session_shutdown", () => {
		headerGeneration++;
		loadedFamily = undefined;
	});
}
