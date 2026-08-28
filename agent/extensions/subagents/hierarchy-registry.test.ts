import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	hierarchyDirectoryForSession,
	publishHierarchySnapshot,
	readHierarchyRegistry,
	type HierarchySnapshot,
} from "./hierarchy-registry.ts";

type Agent = { id: string; state: string };
type Batch = { id: string };

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-hierarchy-registry-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeSnapshot(directory: string, snapshot: HierarchySnapshot<Agent, Batch>): Promise<string> {
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, `${snapshot.ownerAgentId}.json`);
	await writeFile(file, `${JSON.stringify(snapshot)}\n`, "utf8");
	return file;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("subagent hierarchy registry", () => {
	test("finds a child-specific registry from its session file", () => {
		const root = path.join("C:", "Temp", "pi-subagent-hierarchy", "root-session");
		const session = path.join("C:", "sessions", "2026-08-28T10-30-47Z_01a047ec-0ce5-7999-a38e-ed9b04d4d838.jsonl");

		expect(hierarchyDirectoryForSession(root, session)).toBe(
			path.join("C:", "Temp", "pi-subagent-hierarchy", "01a047ec-0ce5-7999-a38e-ed9b04d4d838"),
		);
	});

	test("does not retain empty reporter snapshots", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSnapshot(directory, { ownerAgentId: "sa-empty", publishedAt: 1, agents: [], batches: [] });

		await publishHierarchySnapshot(directory, "sa-empty", [], []);

		expect(existsSync(file)).toBe(false);
	});

	test("publishes non-empty snapshots atomically", async () => {
		const directory = await temporaryDirectory();
		await publishHierarchySnapshot<Agent, Batch>(directory, "sa-parent", [{ id: "sa-child", state: "running" }], []);

		const value = JSON.parse(await readFile(path.join(directory, "sa-parent.json"), "utf8"));
		expect(value.ownerAgentId).toBe("sa-parent");
		expect(value.agents).toEqual([{ id: "sa-child", state: "running" }]);
		expect(await readdir(directory)).toEqual(["sa-parent.json"]);
	});

	test("consumes stale snapshots once and keeps their history in memory", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSnapshot(directory, {
			ownerAgentId: "sa-parent",
			publishedAt: 100,
			agents: [{ id: "sa-child", state: "running" }],
			batches: [],
		});
		const cache = new Map<string, HierarchySnapshot<Agent, Batch>>();

		const first = await readHierarchyRegistry(directory, cache, 50, 200);
		const second = await readHierarchyRegistry(directory, cache, 50, 300);

		expect(existsSync(file)).toBe(false);
		expect(first).toEqual(second);
		expect(second[0]?.agents[0]?.id).toBe("sa-child");
	});

	test("accepts a resumed reporter with the same agent id", async () => {
		const directory = await temporaryDirectory();
		const cache = new Map<string, HierarchySnapshot<Agent, Batch>>();
		await writeSnapshot(directory, {
			ownerAgentId: "sa-parent",
			publishedAt: 100,
			agents: [{ id: "sa-old", state: "running" }],
			batches: [],
		});
		await readHierarchyRegistry(directory, cache, 50, 200);
		await writeSnapshot(directory, {
			ownerAgentId: "sa-parent",
			publishedAt: 300,
			agents: [{ id: "sa-new", state: "running" }],
			batches: [],
		});

		const snapshots = await readHierarchyRegistry(directory, cache, 50, 300);

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.agents[0]?.id).toBe("sa-new");
	});

	test("removes stale empty files during migration", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSnapshot(directory, { ownerAgentId: "sa-empty", publishedAt: 100, agents: [], batches: [] });
		const cache = new Map<string, HierarchySnapshot<Agent, Batch>>();

		const snapshots = await readHierarchyRegistry(directory, cache, 50, 200);

		expect(snapshots).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});
});
