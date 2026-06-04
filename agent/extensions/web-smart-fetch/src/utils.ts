import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sha1(input: string): string {
	return createHash("sha1").update(input).digest("hex");
}

export function safeName(input: string): string {
	return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "item";
}

export function ensureDir(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

export function makeArtifactDir(baseDir: string, prefix: string, key: string): string {
	const stamp = new Date().toISOString().replace(/[.:]/g, "-");
	const dir = join(baseDir, `${prefix}_${stamp}_${sha1(key).slice(0, 10)}`);
	return ensureDir(dir);
}

export function saveText(path: string, text: string): string {
	writeFileSync(path, text, "utf8");
	return path;
}

export function saveBuffer(path: string, data: Uint8Array): string {
	writeFileSync(path, data);
	return path;
}

export function saveJson(path: string, value: unknown): string {
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
	return path;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.72);
	const tail = Math.max(500, Math.floor(max * 0.18));
	return `${text.slice(0, head)}\n\n[...content trimmed...]\n\n${text.slice(-tail)}`;
}

export function preview(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n\n[preview truncated]`;
}

export function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[>*_~]/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function listTree(root: string, maxEntries = 120, depth = 2, prefix = ""): string[] {
	if (depth < 0) return [];
	const out: string[] = [];
	for (const name of readdirSync(root).sort()) {
		if (name === ".git" || name === "node_modules") continue;
		const full = join(root, name);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		out.push(`${prefix}${name}${isDir ? "/" : ""}`);
		if (out.length >= maxEntries) break;
		if (isDir && depth > 0) {
			for (const child of listTree(full, maxEntries - out.length, depth - 1, `${prefix}${name}/`)) {
				out.push(child);
				if (out.length >= maxEntries) break;
			}
		}
		if (out.length >= maxEntries) break;
	}
	return out;
}

export function readMaybe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function tempFile(name: string): string {
	return join(tmpdir(), name);
}

// Keep a default export as a compatibility shim for loaders/transpilers that
// rewrite named imports from .ts modules as default-property access.
export default {
	sha1,
	safeName,
	ensureDir,
	makeArtifactDir,
	saveText,
	saveBuffer,
	saveJson,
	truncate,
	preview,
	stripMarkdown,
	listTree,
	readMaybe,
	tempFile,
};
