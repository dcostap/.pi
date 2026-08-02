import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";

export type SessionFileSource = {
	getSessionFile(): string | undefined;
	getHeader(): unknown;
	getEntries(): readonly unknown[];
};

/**
 * Materialize a session manager's in-memory header and entries before another
 * Pi process opens its session path. New sessions are otherwise persisted
 * lazily, which would lose metadata such as parentSession across the process
 * boundary.
 */
export async function materializeSessionFile(session: SessionFileSource): Promise<string> {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("subagent session is not persisted");
	if (existsSync(sessionFile)) return sessionFile;

	const header = session.getHeader();
	if (!header) throw new Error("subagent session has no valid session header");
	const content = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	const temporaryPath = `${sessionFile}.subagent-tmp-${process.pid}-${Date.now()}-${randomUUID()}`;

	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
		if (existsSync(sessionFile)) throw new Error(`subagent session file already exists: ${sessionFile}`);
		await rename(temporaryPath, sessionFile);
	} finally {
		await unlink(temporaryPath).catch(() => {});
	}

	return sessionFile;
}
