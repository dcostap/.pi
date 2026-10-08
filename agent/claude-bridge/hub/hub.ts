// Keeps one headless Pi "hub" per Claude Code session. The hub loads the usual
// extensions (so extension providers work). The subagents extension sees
// PI_SUBAGENT_BRIDGE_DIR and serves its tools over local HTTP.
//
//   bun hub.ts ensure --session <id> --cwd <dir>   start the hub if needed, print hub.json
//   bun hub.ts call <tool> [json] --session <id>   call one tool (for tests and manual use)
//   bun hub.ts drain|state|stop --session <id>
//   bun hub.ts run --session <id> --cwd <dir>      the keeper (ensure starts it)
//   bun hub.ts tools                               print the tool specs (cached)
//
// `pi --mode rpc` exits when stdin closes. The keeper holds stdin open and
// exits with Pi. The hub stops itself after 15 minutes without requests.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const START_TIMEOUT_MS = 60_000;

type HubInfo = { port: number; token: string; pid: number; startedAt: number };

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function stateRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "claude-bridge-state");
}

export function stateDir(session: string): string {
	return path.join(stateRoot(), session);
}

// Tool specs are the same for every hub. A cache lets a Claude Code session
// register the tools at start without starting a hub.
const toolsCache = () => path.join(stateRoot(), "tools.json");

async function refreshTools(info: HubInfo): Promise<unknown> {
	const tools = await post(info, "/tools");
	await mkdir(stateRoot(), { recursive: true });
	await writeFile(toolsCache(), JSON.stringify(tools), "utf8");
	return tools;
}

async function tools(): Promise<unknown> {
	try {
		return JSON.parse(await readFile(toolsCache(), "utf8"));
	} catch {
		const probe = "tools-probe";
		const info = await ensure(probe, homedir());
		await post(info, "/shutdown");
		return JSON.parse(await readFile(toolsCache(), "utf8"));
	}
}

async function readInfo(dir: string): Promise<HubInfo | undefined> {
	try {
		return JSON.parse(await readFile(path.join(dir, "hub.json"), "utf8"));
	} catch {
		return undefined;
	}
}

async function post(info: HubInfo, endpoint: string, body: unknown = {}): Promise<any> {
	const response = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${endpoint} failed with HTTP ${response.status}: ${await response.text()}`);
	return response.json();
}

async function alive(info: HubInfo | undefined): Promise<boolean> {
	if (!info) return false;
	try {
		await post(info, "/ping");
		return true;
	} catch {
		return false;
	}
}

async function ensure(session: string, cwd: string): Promise<HubInfo> {
	const dir = stateDir(session);
	const current = await readInfo(dir);
	if (await alive(current)) return current!;
	await rm(path.join(dir, "hub.json"), { force: true });
	mkdirSync(dir, { recursive: true });
	const keeper = spawn(process.execPath, [import.meta.path, "run", "--session", session, "--cwd", cwd], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	keeper.unref();
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await Bun.sleep(200);
		const info = await readInfo(dir);
		if (!(await alive(info))) continue;
		await refreshTools(info!);
		return info!;
	}
	throw new Error(`The Pi hub did not start in ${START_TIMEOUT_MS / 1000}s. See ${path.join(dir, "hub.log")}`);
}

async function run(session: string, cwd: string): Promise<number> {
	const dir = stateDir(session);
	mkdirSync(path.join(dir, "sessions"), { recursive: true });
	const log = openSync(path.join(dir, "hub.log"), "a");
	const pi = spawn(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc",
		"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"--session-dir", path.join(dir, "sessions"),
	], {
		cwd,
		env: { ...process.env, PI_SUBAGENT_BRIDGE_DIR: dir },
		// stdin stays open. Pi exits on EOF.
		stdio: ["pipe", "ignore", log],
		windowsHide: true,
	});
	// The bridge removes hub.json when it stops (/shutdown or idle). An idle
	// RPC Pi does not finish ctx.shutdown(), so close stdin: Pi then shuts down
	// in order and stops its subagents.
	const infoFile = path.join(dir, "hub.json");
	let started = false;
	const watch = setInterval(() => {
		if (existsSync(infoFile)) started = true;
		else if (started) {
			clearInterval(watch);
			pi.stdin?.end();
		}
	}, 500);
	const code = await new Promise<number>((resolve) => {
		pi.once("error", () => resolve(1));
		pi.once("exit", (exitCode) => resolve(exitCode ?? 1));
	});
	clearInterval(watch);
	// Pi removes hub.json on a clean shutdown. Remove a stale one after a crash.
	const info = await readInfo(dir);
	if (info && !(await alive(info))) await rm(path.join(dir, "hub.json"), { force: true });
	return code;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const session = option(argv, "--session");
	const cwd = option(argv, "--cwd") ?? process.cwd();
	if (command === "tools") {
		console.log(JSON.stringify(await tools()));
		return 0;
	}
	if (!session) {
		console.error("Usage: hub.ts ensure|run|call|drain|state|stop --session <id> [--cwd <dir>] | hub.ts tools");
		return 2;
	}
	if (command === "run") return run(session, cwd);
	if (command === "ensure") {
		console.log(JSON.stringify(await ensure(session, cwd)));
		return 0;
	}
	const info = await readInfo(stateDir(session));
	if (command === "stop") {
		if (await alive(info)) await post(info!, "/shutdown");
		return 0;
	}
	if (!(await alive(info))) {
		console.error("No Pi hub runs for this session.");
		return 1;
	}
	if (command === "call") {
		const [tool, json] = rest;
		const params = json && !json.startsWith("--") ? JSON.parse(json) : {};
		let result = await post(info!, "/call", { tool, params });
		while (result.pending) result = await post(info!, "/job", { id: result.pending });
		console.log(result.text);
		return result.isError ? 1 : 0;
	}
	if (command === "drain" || command === "state") {
		console.log(JSON.stringify(await post(info!, `/${command}`), null, 2));
		return 0;
	}
	console.error(`Unknown command ${command}`);
	return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
