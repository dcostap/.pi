import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

export function linkUrl(label: string, url: string): string {
	return getCapabilities().hyperlinks ? hyperlink(label, url) : label;
}

/** Use the full path as the target, even when the label is shortened. */
export function linkFile(label: string, path: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return label;
	const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
	return hyperlink(label, pathToFileURL(absolutePath).href);
}

/** Link only known local paths. Do not infer paths from command output. */
export function linkFilePaths(text: string, paths: readonly string[], cwd: string): string {
	const unique = [...new Set(paths.filter(Boolean))].sort((a, b) => b.length - a.length);
	if (!getCapabilities().hyperlinks || unique.length === 0) return text;
	const pattern = unique.map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return text.replace(new RegExp(pattern, "g"), (path) => linkFile(path, path, cwd));
}
