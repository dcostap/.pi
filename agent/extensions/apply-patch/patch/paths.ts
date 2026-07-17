import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DiffError } from "./types.ts";

export function normalizePatchPath({ path }: { path: string }): string {
	// Codex treats the text after a hunk marker as the literal path. In
	// particular, quotes and a leading `@` are filename characters rather than
	// shell syntax. Hunk-line whitespace is handled by the patch parser before
	// it extracts this value.
	return path;
}

// Match Codex apply_patch path handling: absolute patch paths are accepted
// as-is, while relative paths are resolved against ctx.cwd.
export function resolvePatchPath({ cwd, patchPath }: { cwd: string; patchPath: string }): string {
	const normalized = normalizePatchPath({ path: patchPath });
	if (!normalized) {
		throw new DiffError("Patch path cannot be empty");
	}

	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

export function openFileAtPath({ cwd, path }: { cwd: string; path: string }): string {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	if (!existsSync(absolutePath)) {
		throw new DiffError(`File not found: ${path}`);
	}
	return readFileSync(absolutePath, "utf8");
}

export function writeFileAtPath({ cwd, path, content }: { cwd: string; path: string; content: string }): { created: boolean } {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	const created = !existsSync(absolutePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content, "utf8");
	return { created };
}

export function removeFileAtPath({ cwd, path }: { cwd: string; path: string }): void {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	if (!existsSync(absolutePath)) {
		throw new DiffError(`File not found: ${path}`);
	}
	unlinkSync(absolutePath);
}

export function pathExists({ cwd, path }: { cwd: string; path: string }): boolean {
	return existsSync(resolvePatchPath({ cwd, patchPath: path }));
}
