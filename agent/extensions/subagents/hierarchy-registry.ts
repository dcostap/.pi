import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type HierarchySnapshot<Agent, Batch> = {
	ownerAgentId: string;
	publishedAt: number;
	agents: Agent[];
	batches: Batch[];
};

function reporterPath(registryDir: string, ownerAgentId: string): string {
	return path.join(registryDir, `${ownerAgentId}.json`);
}

async function removeFile(file: string): Promise<void> {
	try {
		await unlink(file);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

export async function removeHierarchyReporter(registryDir: string, ownerAgentId: string): Promise<void> {
	await removeFile(reporterPath(registryDir, ownerAgentId));
}

export async function publishHierarchySnapshot<Agent, Batch>(
	registryDir: string,
	ownerAgentId: string,
	agents: Agent[],
	batches: Batch[],
): Promise<void> {
	const target = reporterPath(registryDir, ownerAgentId);
	if (agents.length === 0 && batches.length === 0) {
		await removeFile(target);
		return;
	}
	await mkdir(registryDir, { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const snapshot: HierarchySnapshot<Agent, Batch> = {
		ownerAgentId,
		publishedAt: Date.now(),
		agents,
		batches,
	};
	try {
		await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
		await rename(temporary, target);
	} finally {
		await removeFile(temporary).catch(() => {});
	}
}

function isSnapshot(value: unknown): value is HierarchySnapshot<unknown, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	return typeof snapshot.ownerAgentId === "string"
		&& typeof snapshot.publishedAt === "number"
		&& Array.isArray(snapshot.agents)
		&& Array.isArray(snapshot.batches);
}

/**
 * Read live reporter files into a durable process-local cache.
 *
 * Empty files have no hierarchy information and are removed immediately.
 * Stale files are consumed once, retained in the cache, and then removed.
 * A reporter that resumes later recreates its file and replaces the cache entry.
 */
export async function readHierarchyRegistry<Agent, Batch>(
	registryDir: string,
	cache: Map<string, HierarchySnapshot<Agent, Batch>>,
	staleMs: number,
	now = Date.now(),
): Promise<HierarchySnapshot<Agent, Batch>[]> {
	let names: string[];
	try {
		names = (await readdir(registryDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return [...cache.values()];
	}
	await Promise.all(names.map(async (name) => {
		const file = path.join(registryDir, name);
		try {
			const value = JSON.parse(await readFile(file, "utf8"));
			if (!isSnapshot(value)) {
				await removeFile(file);
				return;
			}
			const snapshot = value as HierarchySnapshot<Agent, Batch>;
			if (snapshot.agents.length === 0 && snapshot.batches.length === 0) {
				cache.delete(snapshot.ownerAgentId);
				await removeFile(file);
				return;
			}
			cache.set(snapshot.ownerAgentId, snapshot);
			if (now - snapshot.publishedAt > staleMs) await removeFile(file);
		} catch (error: any) {
			if (error?.code !== "ENOENT") await removeFile(file).catch(() => {});
		}
	}));
	return [...cache.values()];
}
