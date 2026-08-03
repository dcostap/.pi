import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type SubagentRole = {
	name: string;
	description: string;
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

function parseRoleSource(source: string, filePath: string, legacyProfile: boolean): SubagentRole {
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
	const allowed = new Set(legacyProfile
		? ["name", "description", "id-prefix", "coordinator-guidelines"]
		: ["name", "description"]);
	for (const key of metadata.keys()) if (!allowed.has(key)) throw new Error(`${filePath}: unknown frontmatter key ${key}`);
	const fallbackName = path.basename(filePath, path.extname(filePath));
	const name = scalar(metadata.get("name") ?? fallbackName);
	const description = scalar(metadata.get("description") ?? "");
	const prompt = match[2]!.trim();
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`${filePath}: name must match [a-z][a-z0-9_-]*`);
	if (!description) throw new Error(`${filePath}: description is required`);
	if (!prompt) throw new Error(`${filePath}: role prompt body is required`);
	return { name, description, prompt, filePath };
}

export function parseRoleMarkdown(source: string, filePath: string): SubagentRole {
	return parseRoleSource(source, filePath, false);
}

export async function loadSubagentRoles(roleDir: string, legacyProfileDir?: string): Promise<Map<string, SubagentRole>> {
	const roles = new Map<string, SubagentRole>();
	let entries: string[];
	try {
		entries = await readdir(roleDir);
	} catch (error) {
		throw new Error(`Could not read subagent role directory ${roleDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(".md")).sort()) {
		const filePath = path.join(roleDir, name);
		const role = parseRoleMarkdown(await readFile(filePath, "utf8"), filePath);
		if (roles.has(role.name)) throw new Error(`Duplicate subagent role name ${role.name}`);
		roles.set(role.name, role);
	}
	if (legacyProfileDir) {
		let legacyEntries: string[] = [];
		try {
			legacyEntries = await readdir(legacyProfileDir);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw new Error(`Could not read legacy subagent profile directory ${legacyProfileDir}: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const name of legacyEntries.filter((entry) => entry.toLowerCase().endsWith(".md")).sort()) {
			const filePath = path.join(legacyProfileDir, name);
			const role = parseRoleSource(await readFile(filePath, "utf8"), filePath, true);
			// A migrated role definition is authoritative when both exist.
			if (!roles.has(role.name)) roles.set(role.name, role);
		}
	}
	return roles;
}
