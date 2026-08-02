import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type SubagentProfile = {
	name: string;
	description: string;
	idPrefix: string;
	coordinatorGuidelines: string[];
	prompt: string;
	filePath: string;
};

function scalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseStringArray(value: string, filePath: string, key: string): string[] {
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) throw new Error();
		return parsed.map((item) => item.trim());
	} catch {
		throw new Error(`${filePath}: ${key} must be a JSON array of non-empty strings`);
	}
}

export function parseProfileMarkdown(source: string, filePath: string): SubagentProfile {
	const normalized = source.replace(/\r\n/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) throw new Error(`${filePath}: expected YAML-style frontmatter delimited by ---`);
	const metadata = new Map<string, string>();
	for (const [index, line] of match[1]!.split("\n").entries()) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error(`${filePath}:${index + 2}: expected key: value`);
		const key = line.slice(0, separator).trim();
		if (metadata.has(key)) throw new Error(`${filePath}: duplicate frontmatter key ${key}`);
		metadata.set(key, line.slice(separator + 1).trim());
	}
	const allowed = new Set(["name", "description", "id-prefix", "coordinator-guidelines"]);
	for (const key of metadata.keys()) if (!allowed.has(key)) throw new Error(`${filePath}: unknown frontmatter key ${key}`);
	const fallbackName = path.basename(filePath, path.extname(filePath));
	const name = scalar(metadata.get("name") ?? fallbackName);
	const description = scalar(metadata.get("description") ?? "");
	const idPrefix = scalar(metadata.get("id-prefix") ?? "sa");
	const prompt = match[2]!.trim();
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`${filePath}: name must match [a-z][a-z0-9_-]*`);
	if (!description) throw new Error(`${filePath}: description is required`);
	if (!/^[a-z][a-z0-9_-]*$/.test(idPrefix)) throw new Error(`${filePath}: id-prefix must match [a-z][a-z0-9_-]*`);
	if (!prompt) throw new Error(`${filePath}: profile prompt body is required`);
	const guidelinesRaw = metadata.get("coordinator-guidelines");
	return {
		name,
		description,
		idPrefix,
		coordinatorGuidelines: guidelinesRaw ? parseStringArray(guidelinesRaw, filePath, "coordinator-guidelines") : [],
		prompt,
		filePath,
	};
}

export async function loadSubagentProfiles(profileDir: string): Promise<Map<string, SubagentProfile>> {
	const profiles = new Map<string, SubagentProfile>();
	let entries: string[];
	try {
		entries = await readdir(profileDir);
	} catch (error) {
		throw new Error(`Could not read subagent profile directory ${profileDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(".md")).sort()) {
		const filePath = path.join(profileDir, name);
		const profile = parseProfileMarkdown(await readFile(filePath, "utf8"), filePath);
		if (profiles.has(profile.name)) throw new Error(`Duplicate subagent profile name ${profile.name}`);
		profiles.set(profile.name, profile);
	}
	return profiles;
}
