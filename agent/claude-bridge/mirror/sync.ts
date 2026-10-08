// Mirrors Claude Code transcripts into Pi session files.
//
//   bun sync.ts session <claude-session-id>   mirror one session
//   bun sync.ts file <transcript.jsonl>       mirror one transcript file
//   bun sync.ts backfill                      mirror every Claude Code session
//
// Options: --claude-dir <dir> (default ~/.claude/projects)
//          --sessions-dir <dir> (default ~/.pi/agent/sessions)
//
// The mirror is rebuilt from the whole transcript each time. Its last entry is
// a marker. When Pi adds a message after the marker (the user continued the
// mirror in Pi), that file is frozen and later syncs write a new mirror.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { convertTranscript, entryId, parseJsonl, type PiEntry } from "./convert.ts";

export const MARKER_TYPE = "claude-code-mirror";

export type SyncOptions = { sessionsDir: string };
export type SyncResult = { status: "written" | "unchanged" | "empty"; file?: string };

/** Pi's session folder name for a working directory. */
export function sessionFolderName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function fileTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

/** Session ID of mirror number `index` for one Claude Code session. */
export function mirrorSessionId(claudeSessionId: string, index: number): string {
	if (index === 0) return claudeSessionId;
	const hex = createHash("sha1").update(`${claudeSessionId}:mirror:${index}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** True when Pi added a message after the mirror's marker. */
export function isFrozen(existing: string, markerId: string): boolean {
	const lines = existing.split("\n").filter((line) => line.trim());
	const markerIndex = lines.findIndex((line) => line.includes(`"id":"${markerId}"`));
	if (markerIndex === -1) {
		// No marker: this file is not a mirror this tool can own.
		return true;
	}
	return lines.slice(markerIndex + 1).some((line) => {
		try {
			return JSON.parse(line)?.type === "message";
		} catch {
			return false;
		}
	});
}

export function renderMirror(header: PiEntry, entries: PiEntry[], sessionId: string, index: number, claudeSessionId: string, source: string): string {
	const renamed = index === 0 ? entries : entries.map((entry) => entry.type === "session_info"
		? { ...entry, name: `${entry.name} (${index + 1})` }
		: entry);
	const last = renamed[renamed.length - 1];
	const marker = {
		type: "custom",
		id: entryId(`${claudeSessionId}:marker`),
		parentId: last?.id ?? null,
		timestamp: last?.timestamp ?? header.timestamp,
		customType: MARKER_TYPE,
		data: { claudeSessionId, source },
	};
	const lines = [{ ...header, id: sessionId }, ...renamed, marker].map((entry) => JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

async function findMirrorFile(folder: string, sessionId: string): Promise<string | undefined> {
	if (!existsSync(folder)) return undefined;
	const suffix = `_${sessionId}.jsonl`;
	const name = (await readdir(folder)).find((entry) => entry.endsWith(suffix));
	return name ? path.join(folder, name) : undefined;
}

async function writeAtomic(file: string, content: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, content, "utf8");
	try {
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function syncTranscript(transcriptFile: string, options: SyncOptions): Promise<SyncResult> {
	const claudeSessionId = path.basename(transcriptFile, ".jsonl");
	const converted = convertTranscript(parseJsonl(await readFile(transcriptFile, "utf8")), claudeSessionId);
	if (!converted || !converted.header.cwd) return { status: "empty" };
	const folder = path.join(options.sessionsDir, sessionFolderName(converted.header.cwd));
	const markerId = entryId(`${claudeSessionId}:marker`);
	for (let index = 0; index < 1000; index++) {
		const sessionId = mirrorSessionId(claudeSessionId, index);
		const content = renderMirror(converted.header, converted.entries, sessionId, index, claudeSessionId, transcriptFile);
		const existingFile = await findMirrorFile(folder, sessionId);
		if (!existingFile) {
			const file = path.join(folder, `${fileTimestamp(converted.header.timestamp)}_${sessionId}.jsonl`);
			await writeAtomic(file, content);
			return { status: "written", file };
		}
		const existing = await readFile(existingFile, "utf8");
		if (isFrozen(existing, markerId)) continue;
		if (existing === content) return { status: "unchanged", file: existingFile };
		await writeAtomic(existingFile, content);
		return { status: "written", file: existingFile };
	}
	throw new Error(`Too many frozen mirrors for ${claudeSessionId}`);
}

export async function findTranscript(claudeDir: string, claudeSessionId: string): Promise<string | undefined> {
	if (!existsSync(claudeDir)) return undefined;
	for (const project of await readdir(claudeDir)) {
		const file = path.join(claudeDir, project, `${claudeSessionId}.jsonl`);
		if (existsSync(file)) return file;
	}
	return undefined;
}

export async function listTranscripts(claudeDir: string): Promise<string[]> {
	if (!existsSync(claudeDir)) return [];
	const files: string[] = [];
	for (const project of await readdir(claudeDir, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const entry of await readdir(path.join(claudeDir, project.name), { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(claudeDir, project.name, entry.name));
		}
	}
	return files;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function main(argv: string[]): Promise<number> {
	const [command, target] = argv;
	const claudeDir = option(argv, "--claude-dir") ?? path.join(homedir(), ".claude", "projects");
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	const options = { sessionsDir: option(argv, "--sessions-dir") ?? path.join(agentDir, "sessions") };
	if (command === "file" && target) {
		console.log(JSON.stringify(await syncTranscript(target, options)));
		return 0;
	}
	if (command === "session" && target) {
		const file = await findTranscript(claudeDir, target);
		if (!file) {
			console.error(`No Claude Code transcript found for session ${target}`);
			return 1;
		}
		console.log(JSON.stringify(await syncTranscript(file, options)));
		return 0;
	}
	if (command === "backfill") {
		let failed = 0;
		for (const file of await listTranscripts(claudeDir)) {
			try {
				const result = await syncTranscript(file, options);
				console.log(`${result.status.padEnd(9)} ${path.basename(file)}${result.file ? ` -> ${result.file}` : ""}`);
			} catch (error) {
				failed++;
				console.error(`failed    ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failed > 0 ? 1 : 0;
	}
	console.error("Usage: sync.ts session <claude-session-id> | file <transcript.jsonl> | backfill [--claude-dir <dir>] [--sessions-dir <dir>]");
	return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
