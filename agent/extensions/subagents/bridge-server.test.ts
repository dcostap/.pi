import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRIDGE_INFO_FILE, startBridgeServer, type BridgeHandlers, type RunningBridge } from "./bridge-server.ts";

let dir: string;
let running: RunningBridge | undefined;

const handlers = (overrides: Partial<BridgeHandlers> = {}): BridgeHandlers => ({
	tools: async () => ({ tools: [{ name: "subagent_list", description: "List", parameters: { type: "object" } }], instructions: "Use tools." }),
	callTool: async (name, params) => ({ text: `${name}:${JSON.stringify(params)}`, isError: false }),
	drain: async () => undefined,
	state: async () => ({ active: 0, pending: 0 }),
	interrupt: async () => {},
	shutdown: async () => {},
	...overrides,
});

async function start(value: BridgeHandlers, idleMs?: number, pollMs?: number) {
	dir = await mkdtemp(path.join(tmpdir(), "bridge-test-"));
	running = await startBridgeServer(dir, value, idleMs, pollMs);
	const info = JSON.parse(await readFile(path.join(dir, BRIDGE_INFO_FILE), "utf8"));
	const post = (endpoint: string, body: unknown = {}, token = info.token) => fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { info, post };
}

afterEach(async () => {
	await running?.close();
	running = undefined;
	await rm(dir, { recursive: true, force: true });
});

describe("bridge server", () => {
	test("rejects a wrong token", async () => {
		const { post } = await start(handlers());
		expect((await post("/ping", {}, "wrong")).status).toBe(401);
	});

	test("calls tools, drains, and reports state", async () => {
		let pending: string | undefined = "update";
		const widths: Array<number | undefined> = [];
		const { post, info } = await start(handlers({
			drain: async () => { const text = pending; pending = undefined; return text; },
			state: async ({ width }) => { widths.push(width); return { text: "tree", active: 1, pending: 0 }; },
		}));
		expect(info.pid).toBe(process.pid);
		expect(await (await post("/call", { tool: "subagent_list", params: { a: 1 } })).json()).toEqual({ text: "subagent_list:{\"a\":1}", isError: false });
		expect(await (await post("/drain")).json()).toEqual({ text: "update" });
		expect(await (await post("/drain")).json()).toEqual({ text: null });
		expect(await (await post("/state")).json()).toEqual({ text: "tree", active: 1, pending: 0 });
		await post("/state", { width: 90 });
		expect(widths).toEqual([undefined, 90]);
		expect((await (await post("/tools")).json()).tools[0].name).toBe("subagent_list");
		expect((await post("/call", {})).status).toBe(500);
	});

	test("a slow tool call answers a job to poll", async () => {
		let finish: (() => void) | undefined;
		const { post } = await start(handlers({
			callTool: () => new Promise((resolve) => { finish = () => resolve({ text: "done", isError: false }); }),
		}), undefined, 100);
		const first = await (await post("/call", { tool: "subagent_wait_for_any" })).json();
		expect(first.pending).toBeString();
		expect(await (await post("/job", { id: first.pending })).json()).toEqual({ pending: first.pending });
		finish!();
		expect(await (await post("/job", { id: first.pending })).json()).toEqual({ text: "done", isError: false });
		expect((await post("/job", { id: first.pending })).status).toBe(500);
	});

	test("shutdown removes hub.json and calls the handler", async () => {
		let stopped = false;
		const { post } = await start(handlers({ shutdown: async () => { stopped = true; } }));
		expect((await post("/shutdown")).status).toBe(200);
		await Bun.sleep(300);
		expect(stopped).toBe(true);
		expect(existsSync(path.join(dir, BRIDGE_INFO_FILE))).toBe(false);
	});

	test("shuts down after the idle time", async () => {
		let stopped = false;
		await start(handlers({ shutdown: async () => { stopped = true; } }), 100);
		await Bun.sleep(400);
		expect(stopped).toBe(true);
	});
});
