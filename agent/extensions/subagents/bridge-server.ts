// Local HTTP bridge for a headless "hub" Pi process.
//
// A hub is `pi --mode rpc` with PI_SUBAGENT_BRIDGE_DIR set. It never runs a
// model. External clients (the Claude Code pi-bridge mod) call the same tool
// handlers the Pi model calls, and pull batched parent updates when they are
// idle, as Pi does at agent_settled.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const BRIDGE_DIR_ENV = "PI_SUBAGENT_BRIDGE_DIR";
export const BRIDGE_INFO_FILE = "hub.json";
export const BRIDGE_RESULTS_FILE = "results.jsonl";
export const BRIDGE_IDLE_MS = 15 * 60_000;
// Some clients end a request after 30 s. A tool call that runs longer
// answers { pending: jobId }, and the client asks /job again.
export const BRIDGE_POLL_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type BridgeToolResult = { text: string; isError: boolean };
export type BridgeToolSpec = { name: string; description: string; parameters: unknown };

export type BridgeHandlers = {
	/** Tool specs and the main-agent instructions Pi adds to its system prompt. */
	tools(): Promise<{ tools: BridgeToolSpec[]; instructions: string }>;
	callTool(name: string, params: unknown): Promise<BridgeToolResult>;
	/** Formatted parent updates for one delivery, or undefined when none wait. */
	drain(): Promise<string | undefined>;
	/** Plain-text tree of active and recently finished agents, or undefined. */
	state(): Promise<{ text?: string; active: number; pending: number }>;
	/** Ends a running subagent_wait_for_any, as a Pi steering message does. */
	interrupt(): Promise<void>;
	shutdown(): Promise<void>;
};

export type BridgeInfo = { port: number; token: string; pid: number; startedAt: number };

export type RunningBridge = {
	info: BridgeInfo;
	close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() ? JSON.parse(text) : {};
}

async function writeInfo(dir: string, info: BridgeInfo): Promise<void> {
	await mkdir(dir, { recursive: true });
	const target = path.join(dir, BRIDGE_INFO_FILE);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(info)}\n`, "utf8");
	await rename(temporary, target);
}

/**
 * Starts the bridge on 127.0.0.1 and writes hub.json into `dir`.
 * The hub shuts down after `idleMs` without a request.
 */
export async function startBridgeServer(dir: string, handlers: BridgeHandlers, idleMs = BRIDGE_IDLE_MS, pollMs = BRIDGE_POLL_MS): Promise<RunningBridge> {
	const token = randomBytes(24).toString("hex");
	let lastRequestAt = Date.now();
	let closing = false;
	const jobs = new Map<string, Promise<BridgeToolResult>>();

	const settle = async (id: string): Promise<BridgeToolResult | { pending: string }> => {
		const job = jobs.get(id);
		if (!job) throw new Error(`unknown job ${id}`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([job, new Promise<undefined>((resolve) => { timer = setTimeout(resolve, pollMs); })]);
		clearTimeout(timer);
		if (!result) return { pending: id };
		jobs.delete(id);
		return result;
	};

	const server: Server = createServer(async (request, response) => {
		lastRequestAt = Date.now();
		const send = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
			send(request.method !== "POST" ? 405 : 401, { error: "unauthorized or wrong method" });
			return;
		}
		try {
			const body = await readBody(request) as Record<string, unknown>;
			switch (request.url) {
				case "/call": {
					if (typeof body.tool !== "string") throw new Error("tool is required");
					const id = randomUUID();
					jobs.set(id, handlers.callTool(body.tool, body.params ?? {}).catch((error) => ({
						text: error instanceof Error ? error.message : String(error),
						isError: true,
					})));
					send(200, await settle(id));
					return;
				}
				case "/job":
					send(200, await settle(String(body.id)));
					return;
				case "/tools":
					send(200, await handlers.tools());
					return;
				case "/drain":
					send(200, { text: await handlers.drain() ?? null });
					return;
				case "/state":
					send(200, await handlers.state());
					return;
				case "/interrupt":
					await handlers.interrupt();
					send(200, { ok: true });
					return;
				case "/ping":
					send(200, { ok: true, pid: process.pid });
					return;
				case "/shutdown":
					send(200, { ok: true });
					// Let the response flush before connections close.
					setTimeout(() => void shutdown(), 50);
					return;
				default:
					send(404, { error: `unknown endpoint ${request.url}` });
			}
		} catch (error) {
			send(500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	// Long waits (subagent_wait_for_any) hold a request open.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("bridge server has no TCP address");
	const info: BridgeInfo = { port: address.port, token, pid: process.pid, startedAt: Date.now() };
	await writeInfo(dir, info);

	const idleTimer = setInterval(() => {
		if (Date.now() - lastRequestAt > idleMs) void shutdown();
	}, Math.min(idleMs, 30_000));
	idleTimer.unref?.();

	const close = async () => {
		clearInterval(idleTimer);
		await rm(path.join(dir, BRIDGE_INFO_FILE), { force: true }).catch(() => {});
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections?.();
		await closed;
	};

	async function shutdown(): Promise<void> {
		if (closing) return;
		closing = true;
		await close();
		await handlers.shutdown();
	}

	return { info, close };
}
