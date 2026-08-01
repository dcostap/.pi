import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	getMarkdownTheme,
	keyHint,
	SessionManager,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildConversationTranscript } from "./_shared/conversation-transcript.ts";

const REVIEW_TOOL_NAME = "launch_review_subagents";
const START_TOOL_NAME = "subagent_start";
const LIST_TOOL_NAME = "subagent_list";
const STATUS_TOOL_NAME = "subagent_status";
const SEND_TOOL_NAME = "subagent_send";
const WAIT_TOOL_NAME = "subagent_wait";
const RESULT_TOOL_NAME = "subagent_result";
const STOP_TOOL_NAME = "subagent_stop";

const MANAGED_CHILD_ENV = "PI_MANAGED_SUBAGENT";
const PROMPT_CACHE_ENV = "PI_SUBAGENT_PROMPT_CACHE_KEY";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CONTEXT_MODES = ["fresh", "transcript", "clone"] as const;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 1024 * 1024;
const NORMAL_LAUNCH_DETAIL_LIMIT = 10;
const MAX_CONCURRENT_SUBAGENTS = 8;
const MAX_RECENT_ACTIVITIES = 5;
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 1_000;
const MAX_RPC_STDERR_CHARS = 128 * 1024;

const FINAL_RESULT_DISCLAIMER = "Reminder: Don't blindly trust the reviewers' conclusions. Synthesize their evidence and make your own judgment.";

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ContextMode = (typeof CONTEXT_MODES)[number];
type AgentRuntimeState = "queued" | "starting" | "running" | "stopping" | "cold";
type RunOutcome = "none" | "completed" | "failed" | "stopped" | "interrupted";
type DeliveryMode = "steer" | "follow_up";

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

type Activity = {
	at: number;
	text: string;
};

type ActiveTool = {
	name: string;
	description: string;
	startedAt: number;
};

type StartSpec = {
	title: string;
	task: string;
	model: string;
	thinking: ThinkingLevel;
	context?: ContextMode;
	system_prompt?: string;
	system_prompt_file?: string;
};

type StartToolParams = Partial<StartSpec> & {
	input_file?: string;
};

type ReviewerSpec = {
	description: string;
	focus?: string;
	model: string;
	thinking: ThinkingLevel;
};

type ReviewParams = {
	what_to_review: string;
	context?: ContextMode;
	system_prompt?: string;
	system_prompt_file?: string;
	reviewers: ReviewerSpec[];
};

type ReviewToolParams = Partial<ReviewParams> & {
	input_file?: string;
};

type SerializedAgent = {
	id: string;
	title: string;
	task: string;
	modelRef: string;
	thinking: ThinkingLevel;
	contextMode: ContextMode;
	sessionFile: string;
	sandboxDir: string;
	systemPromptPath?: string;
	promptCacheKey?: string;
	createdAt: number;
	runNumber: number;
};

type AgentRecord = SerializedAgent & {
	state: AgentRuntimeState;
	lastOutcome: RunOutcome;
	currentRunId?: string;
	currentPrompt?: string;
	currentTaskSummary?: string;
	startedAt?: number;
	updatedAt: number;
	settledAt?: number;
	lastObservedAt?: number;
	activeTools: Map<string, ActiveTool>;
	recent: Activity[];
	usage: UsageStats;
	contextWindow?: number;
	contextTokens?: number;
	finalAnswer: string;
	error?: string;
	attempt: number;
	stopRequested: boolean;
	client?: RpcClient;
	completion?: Promise<void>;
	resolveCompletion?: () => void;
	waiters: number;
	deliveryPending: boolean;
	deliveryConsumed: boolean;
};

type PreparedAgent = {
	record: AgentRecord;
	prompt: string;
};

type ManagerEvent =
	| { kind: "changed"; id: string }
	| { kind: "settled"; id: string };

type LaunchManifestMetadata = {
	path: string;
	sha256: string;
	bytes: number;
	entries: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function oneLine(value: string, max = 120): string {
	const text = cleanText(value).replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sanitizeTitle(value: string): string {
	return oneLine(value, 96) || "Subagent";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return `${Math.round(value / 1_000)}k`;
}

function formatCost(value: number): string {
	return value === 0 ? "$0.000" : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

function totalUsageTokens(usage: UsageStats): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function modelRef(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function exactModel(ctx: ExtensionContext, raw: string): Model<any> {
	const requested = cleanText(raw);
	const slash = requested.indexOf("/");
	if (slash <= 0 || slash === requested.length - 1) {
		throw new Error(`Model must be an exact provider/model-id, received: ${JSON.stringify(requested)}`);
	}
	const provider = requested.slice(0, slash);
	const id = requested.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider, id) as Model<any> | undefined;
	if (!model || model.provider !== provider || model.id !== id) {
		throw new Error(`Exact model is unavailable: ${requested}`);
	}
	const available = ctx.modelRegistry.getAvailable() as Model<any>[];
	if (!available.some((candidate) => candidate.provider === provider && candidate.id === id)) {
		throw new Error(`Exact model is configured but not currently usable (check authentication): ${requested}`);
	}
	return model;
}

function supportedThinkingLevels(model: Model<any>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function validateThinking(model: Model<any>, thinking: ThinkingLevel): void {
	const supported = supportedThinkingLevels(model);
	if (!supported.includes(thinking)) {
		throw new Error(`${modelRef(model)} does not support thinking level ${thinking}. Supported: ${supported.join(", ")}`);
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function assistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return cleanText(message.content);
	if (!Array.isArray(message.content)) return "";
	return cleanText(message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n"));
}

function finalAssistantText(messages: any[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]);
		if (text) return text;
	}
	return "";
}

function updateUsage(record: AgentRecord, message: any): void {
	const usage = message?.usage;
	if (!usage) return;
	const input = Number(usage.input || 0);
	const output = Number(usage.output || 0);
	const cacheRead = Number(usage.cacheRead || 0);
	const cacheWrite = Number(usage.cacheWrite || 0);
	record.usage.input += input;
	record.usage.output += output;
	record.usage.cacheRead += cacheRead;
	record.usage.cacheWrite += cacheWrite;
	record.usage.cost += Number(usage.cost?.total || 0);
	record.usage.turns++;
	const contextTokens = Number(usage.totalTokens || input + output + cacheRead + cacheWrite);
	if (contextTokens > 0) record.contextTokens = contextTokens;
}

function compactToolActivity(name: string, args: any): string {
	if (name === "bash") return `bash — ${oneLine(String(args?.command ?? "command"), 100)}`;
	if (name === "read") return `read — ${oneLine(String(args?.path ?? args?.file_path ?? "file"), 100)}`;
	if (name === "write") return `write — ${oneLine(String(args?.path ?? args?.file_path ?? "file"), 100)}`;
	if (name === "edit" || name === "apply_patch") return `${name} — ${oneLine(String(args?.path ?? args?.file_path ?? "project files"), 100)}`;
	if (name === "grep") return `grep — ${oneLine(String(args?.pattern ?? "pattern"), 100)}`;
	if (name === "find" || name === "everything_search") return `${name} — ${oneLine(String(args?.query ?? args?.pattern ?? "search"), 100)}`;
	return `${name} — ${oneLine(JSON.stringify(args ?? {}), 100)}`;
}

function addActivity(record: AgentRecord, text: string, at = Date.now()): void {
	record.lastObservedAt = at;
	record.updatedAt = at;
	record.recent.push({ at, text });
	if (record.recent.length > MAX_RECENT_ACTIVITIES) record.recent.splice(0, record.recent.length - MAX_RECENT_ACTIVITIES);
}

function currentActivity(record: AgentRecord): string {
	if (record.activeTools.size > 0) {
		return [...record.activeTools.values()].map((tool) => tool.description).join("; ");
	}
	return record.recent.at(-1)?.text ?? (record.state === "cold" ? `last run ${record.lastOutcome}` : record.state);
}

function serializeAgent(record: AgentRecord): SerializedAgent {
	return {
		id: record.id,
		title: record.title,
		task: record.task,
		modelRef: record.modelRef,
		thinking: record.thinking,
		contextMode: record.contextMode,
		sessionFile: record.sessionFile,
		sandboxDir: record.sandboxDir,
		systemPromptPath: record.systemPromptPath,
		promptCacheKey: record.promptCacheKey,
		createdAt: record.createdAt,
		runNumber: record.runNumber,
	};
}

function newRecord(serialized: SerializedAgent): AgentRecord {
	return {
		...serialized,
		state: "cold",
		lastOutcome: "none",
		updatedAt: serialized.createdAt,
		activeTools: new Map(),
		recent: [],
		usage: emptyUsage(),
		finalAnswer: "",
		attempt: 0,
		stopRequested: false,
		waiters: 0,
		deliveryPending: false,
		deliveryConsumed: false,
	};
}

function runMarker(runId: string): string {
	return `<managed_subagent_run id="${runId}">`;
}

function wrapRunPrompt(runId: string, prompt: string): string {
	return `${runMarker(runId)}\n${prompt}\n</managed_subagent_run>`;
}

function runIdFromText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.match(/<managed_subagent_run id="([^"]+)">/)?.[1];
}

function taskSummaryFromRunText(value: string): string {
	const task = value.match(/<task>\s*([\s\S]*?)\s*<\/task>/)?.[1];
	if (task) return oneLine(task, 160);
	return oneLine(value
		.replace(/^\s*<managed_subagent_run[^>]*>\s*/, "")
		.replace(/\s*<\/managed_subagent_run>\s*$/, ""), 160);
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function inspectPersistedRecord(record: AgentRecord): void {
	try {
		const manager = SessionManager.open(record.sessionFile);
		const entries = manager.getBranch();
		const messages = entries.filter((entry: any) => entry?.type === "message").map((entry: any) => entry.message);
		let maxRun = record.runNumber;
		let latestRunId: string | undefined;
		let latestRunIndex = -1;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (message?.role === "user") {
				const id = runIdFromText(messageText(message));
				const match = id?.match(/-r(\d+)$/);
				if (match) maxRun = Math.max(maxRun, Number(match[1]));
				if (id) {
					latestRunId = id;
					latestRunIndex = index;
					record.currentTaskSummary = taskSummaryFromRunText(messageText(message));
				}
			}
			if (message?.role === "assistant") updateUsage(record, message);
		}
		record.runNumber = maxRun;
		record.currentRunId = latestRunId;
		const lastAssistant = latestRunIndex >= 0
			? messages.slice(latestRunIndex + 1).reverse().find((message) => message?.role === "assistant")
			: [...messages].reverse().find((message) => message?.role === "assistant");
		if (lastAssistant) {
			if (lastAssistant.stopReason === "error" || lastAssistant.errorMessage) {
				record.lastOutcome = "failed";
				record.error = lastAssistant.errorMessage || "assistant error";
			} else if (lastAssistant.stopReason === "length") {
				record.lastOutcome = "failed";
				record.error = "Assistant response stopped at the token limit";
			} else if (lastAssistant.stopReason !== "stop") {
				record.lastOutcome = "interrupted";
				record.error = undefined;
			} else {
				record.lastOutcome = "completed";
				record.finalAnswer = assistantText(lastAssistant);
			}
		} else if (latestRunIndex >= 0) {
			record.lastOutcome = "interrupted";
		}
	} catch (error) {
		record.lastOutcome = "failed";
		record.error = `Could not open child session: ${error instanceof Error ? error.message : String(error)}`;
	}
	record.state = "cold";
}

class RpcClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private exitPromise?: Promise<number | null>;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
	stderr = "";

	constructor(
		private readonly record: AgentRecord,
		private readonly cwd: string,
		private readonly onEvent: (event: any) => void,
	) {}

	start(): void {
		const args = [
			"--mode", "rpc",
			"--session", this.record.sessionFile,
			"--model", this.record.modelRef,
			"--thinking", this.record.thinking,
			"--name", `[Subagent ${this.record.id}] ${this.record.title}`,
		];
		if (this.record.systemPromptPath) args.push("--append-system-prompt", this.record.systemPromptPath);
		const invocation = getPiInvocation(args);
		this.child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				[MANAGED_CHILD_ENV]: "1",
				PI_SUBAGENT_SANDBOX: this.record.sandboxDir,
				[PROMPT_CACHE_ENV]: this.record.promptCacheKey ?? this.record.sessionFile,
			},
		});
		this.child.stdout.on("data", (chunk) => {
			this.buffer += chunk.toString();
			let index = this.buffer.indexOf("\n");
			while (index !== -1) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				if (line) this.handleLine(line);
				index = this.buffer.indexOf("\n");
			}
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
			if (this.stderr.length > MAX_RPC_STDERR_CHARS) this.stderr = this.stderr.slice(-MAX_RPC_STDERR_CHARS);
		});
		this.child.stdin.on("error", (error) => { this.rejectPending(error); });
		this.child.on("error", (error) => {
			this.rejectPending(error);
		});
	}

	async send(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded || child.exitCode !== null) {
			throw new Error("Subagent RPC process is not running");
		}
		const id = `${this.record.id}-${this.nextId++}`;
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC ${type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			try {
				child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (error?: Error | null) => {
					if (!error) return;
					this.rejectOne(id, error);
				});
			} catch (error) {
				this.rejectOne(id, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	waitForExit(): Promise<number | null> {
		if (this.exitPromise) return this.exitPromise;
		this.exitPromise = new Promise((resolve) => {
			if (!this.child) return resolve(null);
			this.child.once("close", (code) => {
				if (this.buffer.trim()) this.handleLine(this.buffer.trim());
				this.rejectPending(new Error(`Subagent exited with code ${code ?? "unknown"}`));
				resolve(code);
			});
		});
		return this.exitPromise;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try { this.child?.kill(signal); } catch {}
	}

	async terminate(graceMs = 2_000): Promise<void> {
		this.kill("SIGTERM");
		const exited = await Promise.race([
			this.waitForExit().then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
		]);
		if (!exited) {
			this.kill("SIGKILL");
			await Promise.race([this.waitForExit(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
		}
	}

	private handleLine(line: string): void {
		let parsed: any;
		try { parsed = JSON.parse(line); } catch { return; }
		if (parsed?.type === "response" && typeof parsed.id === "string") {
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timeout);
			if (parsed.success) pending.resolve(parsed);
			else pending.reject(new Error(parsed.error || `RPC ${parsed.command || "command"} failed`));
			return;
		}
		this.onEvent(parsed);
	}

	private rejectOne(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		pending.reject(error);
	}

	private rejectPending(error: Error): void {
		for (const [id] of this.pending) this.rejectOne(id, error);
	}
}

class SubagentWaitAbortedError extends Error {
	constructor() {
		super("Subagent wait aborted; unfinished subagents are still running");
		this.name = "SubagentWaitAbortedError";
	}
}

class SubagentManager {
	private readonly records = new Map<string, AgentRecord>();
	private readonly queue: AgentRecord[] = [];
	private readonly listeners = new Set<(event: ManagerEvent) => void>();
	private activeCount = 0;
	private disposed = false;

	constructor(private readonly cwd: string, private readonly maxConcurrent = MAX_CONCURRENT_SUBAGENTS) {}

	restore(items: SerializedAgent[]): void {
		for (const item of items) {
			if (this.records.has(item.id)) continue;
			const record = newRecord(item);
			inspectPersistedRecord(record);
			this.records.set(record.id, record);
		}
	}

	add(prepared: PreparedAgent): AgentRecord {
		this.assertActive();
		if (this.records.has(prepared.record.id)) throw new Error(`Duplicate subagent ID: ${prepared.record.id}`);
		const record = prepared.record;
		record.currentPrompt = prepared.prompt;
		record.currentTaskSummary = oneLine(record.task, 160);
		record.state = "queued";
		record.lastOutcome = "none";
		record.runNumber++;
		record.currentRunId = `${record.id}-r${record.runNumber}`;
		record.completion = new Promise<void>((resolve) => { record.resolveCompletion = resolve; });
		this.records.set(record.id, record);
		this.queue.push(record);
		addActivity(record, "queued");
		this.emit({ kind: "changed", id: record.id });
		this.pump();
		return record;
	}

	list(): AgentRecord[] {
		return [...this.records.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	get(id: string): AgentRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown subagent ID: ${id}`);
		return record;
	}

	async send(id: string, message: string, delivery: DeliveryMode): Promise<{ record: AgentRecord; continued: boolean }> {
		this.assertActive();
		const record = this.get(id);
		const prompt = cleanText(message);
		if (!prompt) throw new Error("message must not be empty");
		if (record.state === "stopping") throw new Error(`${id} is stopping; wait until it is cold before sending another task`);
		if ((record.state === "running" || record.state === "starting") && record.client) {
			await record.client.send(delivery === "steer" ? "steer" : "follow_up", { message: prompt });
			record.currentTaskSummary = oneLine(prompt, 160);
			addActivity(record, `${delivery === "steer" ? "steering" : "follow-up"} message accepted: ${oneLine(prompt, 90)}`);
			this.emit({ kind: "changed", id });
			return { record, continued: false };
		}
		if (record.state === "queued") throw new Error(`${id} is queued and has not started; wait for it to begin before sending another task`);
		record.currentPrompt = prompt;
		record.currentTaskSummary = oneLine(prompt, 160);
		record.runNumber++;
		record.currentRunId = `${record.id}-r${record.runNumber}`;
		record.state = "queued";
		record.lastOutcome = "none";
		record.error = undefined;
		record.finalAnswer = "";
		record.stopRequested = false;
		record.attempt = 0;
		record.activeTools.clear();
		record.completion = new Promise<void>((resolve) => { record.resolveCompletion = resolve; });
		record.deliveryPending = false;
		record.deliveryConsumed = false;
		this.queue.push(record);
		addActivity(record, `continuation queued: ${oneLine(prompt, 90)}`);
		this.emit({ kind: "changed", id });
		this.pump();
		return { record, continued: true };
	}

	async wait(ids: string[], signal?: AbortSignal, consumeDelivery = true): Promise<AgentRecord[]> {
		this.assertActive();
		const records = [...new Set(ids)].map((id) => this.get(id));
		for (const record of records) record.waiters++;
		let completed = false;
		let abortHandler: (() => void) | undefined;
		const abortPromise = signal ? new Promise<never>((_resolve, reject) => {
			abortHandler = () => reject(new SubagentWaitAbortedError());
			signal.addEventListener("abort", abortHandler, { once: true });
		}) : new Promise<never>(() => {});
		try {
			if (signal?.aborted) throw new SubagentWaitAbortedError();
			await Promise.race([
				Promise.all(records.map((record) => record.completion ?? Promise.resolve())),
				abortPromise,
			]);
			if (consumeDelivery) {
				for (const record of records) {
					record.deliveryConsumed = true;
					record.deliveryPending = false;
				}
			}
			completed = true;
			return records;
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			for (const record of records) {
				record.waiters = Math.max(0, record.waiters - 1);
				if (!completed && record.waiters === 0 && record.state === "cold" && !record.deliveryConsumed) {
					record.deliveryPending = true;
					this.emit({ kind: "settled", id: record.id });
				}
			}
		}
	}

	async stop(ids: string[]): Promise<AgentRecord[]> {
		const records = [...new Set(ids)].map((id) => this.get(id));
		await Promise.all(records.map(async (record) => {
			record.stopRequested = true;
			record.deliveryConsumed = true;
			record.deliveryPending = false;
			if (record.state === "queued") {
				const index = this.queue.indexOf(record);
				if (index >= 0) this.queue.splice(index, 1);
				record.state = "cold";
				record.lastOutcome = "stopped";
				record.settledAt = Date.now();
				addActivity(record, "stopped before launch");
				record.resolveCompletion?.();
				record.resolveCompletion = undefined;
				this.emit({ kind: "settled", id: record.id });
				return;
			}
			if (record.state !== "running" && record.state !== "starting" && record.state !== "stopping") return;
			record.state = "stopping";
			addActivity(record, "stop requested");
			this.emit({ kind: "changed", id: record.id });
			try { await record.client?.send("abort", {}, 3_000); } catch {}
			await Promise.race([record.completion ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
			if (record.state !== "cold") await record.client?.terminate();
		}));
		return records;
	}

	getDeliverable(): AgentRecord[] {
		return this.list().filter((record) => record.deliveryPending && !record.deliveryConsumed && record.waiters === 0);
	}

	markDelivered(ids: string[]): void {
		for (const id of ids) {
			const record = this.records.get(id);
			if (!record) continue;
			record.deliveryPending = false;
			record.deliveryConsumed = true;
		}
	}

	subscribe(listener: (event: ManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const active = this.list().filter((record) => record.state === "running" || record.state === "starting" || record.state === "queued" || record.state === "stopping");
		await this.stop(active.map((record) => record.id)).catch(() => {});
		await Promise.all(active.map((record) => record.client?.terminate().catch(() => {})));
		this.listeners.clear();
	}

	private pump(): void {
		queueMicrotask(() => {
			while (!this.disposed && this.activeCount < this.maxConcurrent && this.queue.length > 0) {
				const record = this.queue.shift()!;
				if (record.stopRequested || record.state !== "queued") continue;
				this.activeCount++;
				void this.run(record).finally(() => {
					this.activeCount--;
					this.pump();
				});
			}
		});
	}

	private async run(record: AgentRecord): Promise<void> {
		let terminalError: string | undefined;
		for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
			record.attempt = attempt;
			record.state = "starting";
			record.startedAt ??= Date.now();
			addActivity(record, attempt === 1 ? "starting Pi RPC session" : `retrying, attempt ${attempt}/${MAX_RETRIES + 1}`);
			this.emit({ kind: "changed", id: record.id });
			let attemptUsedTool = false;
			let resolveSettled!: () => void;
			const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
			const client = new RpcClient(record, this.cwd, (event) => {
				if (event.type === "tool_execution_start") attemptUsedTool = true;
				this.applyEvent(record, event);
				if (event.type === "agent_settled") {
					resolveSettled();
				}
				this.emit({ kind: "changed", id: record.id });
			});
			record.client = client;
			try {
				client.start();
				const exitPromise = client.waitForExit();
				const prompt = wrapRunPrompt(record.currentRunId!, record.currentPrompt!);
				await client.send("prompt", { message: prompt });
				record.state = "running";
				addActivity(record, "task accepted");
				this.emit({ kind: "changed", id: record.id });
				try {
					const stateResponse = await client.send("get_state", {}, 5_000);
					if (typeof stateResponse?.data?.model?.contextWindow === "number") record.contextWindow = stateResponse.data.model.contextWindow;
				} catch {}
				const winner = await Promise.race([settledPromise.then(() => "settled" as const), exitPromise.then(() => "exit" as const)]);
				if (winner === "settled") {
					await client.terminate();
					if (!record.stopRequested && !attemptUsedTool && isTransientFailure(record.error) && attempt <= MAX_RETRIES) {
						terminalError = record.error;
						record.error = undefined;
						await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
						continue;
					}
					terminalError = undefined;
					break;
				}
				const exitCode = await exitPromise;
				terminalError = client.stderr.trim() || `Subagent exited before settling with code ${exitCode ?? "unknown"}`;
			} catch (error) {
				terminalError = error instanceof Error ? error.message : String(error);
				await client.terminate().catch(() => {});
			}
			if (record.stopRequested) break;
			if (attemptUsedTool || !isTransientFailure(terminalError) || attempt > MAX_RETRIES) break;
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
		}
		record.client = undefined;
		record.activeTools.clear();
		record.state = "cold";
		record.settledAt = Date.now();
		if (record.stopRequested) {
			record.lastOutcome = "stopped";
			record.error = undefined;
			addActivity(record, "stopped");
		} else if (terminalError) {
			record.lastOutcome = "failed";
			record.error = terminalError;
			addActivity(record, `failed: ${oneLine(terminalError, 120)}`);
		} else if (record.error) {
			record.lastOutcome = "failed";
			addActivity(record, `failed: ${oneLine(record.error, 120)}`);
		} else {
			record.lastOutcome = "completed";
			addActivity(record, "completed");
		}
		record.deliveryPending = record.waiters === 0 && !record.deliveryConsumed;
		record.resolveCompletion?.();
		record.resolveCompletion = undefined;
		this.emit({ kind: "settled", id: record.id });
	}

	private applyEvent(record: AgentRecord, event: any): void {
		const now = Date.now();
		record.updatedAt = now;
		record.lastObservedAt = now;
		if (event.type === "agent_start") {
			record.state = "running";
			addActivity(record, "agent running", now);
			return;
		}
		if (event.type === "tool_execution_start") {
			const description = compactToolActivity(event.toolName, event.args);
			record.activeTools.set(event.toolCallId, { name: event.toolName, description, startedAt: now });
			addActivity(record, description, now);
			return;
		}
		if (event.type === "tool_execution_end") {
			const active = record.activeTools.get(event.toolCallId);
			record.activeTools.delete(event.toolCallId);
			if (active) addActivity(record, `${active.name} ${event.isError ? "failed" : "finished"}`, now);
			return;
		}
		if (event.type === "message_update") {
			const type = event.assistantMessageEvent?.type;
			if (type === "thinking_start") addActivity(record, "thinking", now);
			else if (type === "text_start") addActivity(record, "writing response", now);
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			updateUsage(record, event.message);
			const text = assistantText(event.message);
			if (text) record.finalAnswer = text;
			if (event.message.stopReason === "error" || event.message.errorMessage) record.error = event.message.errorMessage || "assistant error";
			else if (event.message.stopReason === "length") record.error = "Assistant response stopped at the token limit";
			return;
		}
		if (event.type === "agent_end") {
			const text = finalAssistantText(event.messages || []);
			if (text) record.finalAnswer = text;
		}
	}

	private emit(event: ManagerEvent): void {
		for (const listener of [...this.listeners]) {
			try { listener(event); } catch {}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Subagent manager is shutting down");
	}
}

function isTransientFailure(message: string | undefined): boolean {
	if (!message) return false;
	return /WebSocket closed|provider_transport_failure|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|stream closed|connection closed|timed out/i.test(message);
}

function validateStartSpec(value: unknown, location: string): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return [`${location}: expected object`];
	const allowed = new Set(["title", "task", "model", "thinking", "context", "system_prompt", "system_prompt_file"]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}.${key}: unknown property`);
	for (const key of ["title", "task", "model"] as const) {
		if (typeof value[key] !== "string" || !cleanText(value[key] as string)) errors.push(`${location}.${key}: required non-empty string`);
	}
	if (!(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) errors.push(`${location}.thinking: required; expected one of ${THINKING_LEVELS.join(", ")}`);
	if (value.context !== undefined && !(CONTEXT_MODES as readonly unknown[]).includes(value.context)) errors.push(`${location}.context: expected one of ${CONTEXT_MODES.join(", ")}`);
	if (value.system_prompt !== undefined && (typeof value.system_prompt !== "string" || !cleanText(value.system_prompt))) errors.push(`${location}.system_prompt: expected non-empty string`);
	if (value.system_prompt_file !== undefined && (typeof value.system_prompt_file !== "string" || !cleanText(value.system_prompt_file))) errors.push(`${location}.system_prompt_file: expected non-empty string`);
	if (value.system_prompt !== undefined && value.system_prompt_file !== undefined) errors.push(`${location}: system_prompt and system_prompt_file are mutually exclusive`);
	if ((value.system_prompt !== undefined || value.system_prompt_file !== undefined) && value.context !== undefined && value.context !== "fresh") errors.push(`${location}: custom system prompts require fresh context`);
	return errors;
}

async function readJsonFile(inputFile: string, cwd: string): Promise<{ value: unknown; metadata: LaunchManifestMetadata }> {
	const resolved = path.resolve(cwd, inputFile.replace(/^@/, ""));
	const info = await stat(resolved);
	if (!info.isFile()) throw new Error(`Expected a regular file: ${resolved}`);
	if (info.size > MAX_MANIFEST_BYTES) throw new Error(`Input file exceeds ${MAX_MANIFEST_BYTES} bytes: ${resolved}`);
	const bytes = await readFile(resolved);
	if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error(`Input file grew beyond ${MAX_MANIFEST_BYTES} bytes while reading`);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value = JSON.parse(text);
	let canonical = resolved;
	try { canonical = await realpath(resolved); } catch {}
	return {
		value,
		metadata: { path: canonical, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, entries: Array.isArray(value) ? value.length : 0 },
	};
}

async function resolveStartSpecs(params: StartToolParams, cwd: string): Promise<{ specs: StartSpec[]; manifest?: LaunchManifestMetadata }> {
	if (!isRecord(params)) throw new Error("Tool input must be an object");
	if (Object.hasOwn(params, "input_file")) {
		if (Object.keys(params).some((key) => key !== "input_file")) throw new Error("input_file must be supplied by itself");
		if (typeof params.input_file !== "string" || !cleanText(params.input_file)) throw new Error("input_file is required and must be non-empty");
		const loaded = await readJsonFile(params.input_file, cwd);
		if (!Array.isArray(loaded.value) || loaded.value.length === 0) throw new Error("Start manifest must be a non-empty JSON array of normal subagent_start requests");
		const errors = loaded.value.flatMap((value, index) => validateStartSpec(value, `manifest[${index}]`));
		if (errors.length > 0) throw new Error(errors.slice(0, 50).join("\n"));
		return { specs: loaded.value as StartSpec[], manifest: loaded.metadata };
	}
	const errors = validateStartSpec(params, "tool input");
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return { specs: [params as StartSpec] };
}

async function readSystemPrompt(spec: Pick<StartSpec, "system_prompt" | "system_prompt_file">, cwd: string): Promise<Buffer | undefined> {
	if (spec.system_prompt !== undefined) {
		const bytes = Buffer.from(spec.system_prompt, "utf8");
		if (bytes.byteLength > MAX_SYSTEM_PROMPT_BYTES) throw new Error(`system_prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
		return bytes;
	}
	if (!spec.system_prompt_file) return undefined;
	const resolved = path.resolve(cwd, spec.system_prompt_file);
	const info = await stat(resolved);
	if (!info.isFile()) throw new Error(`system_prompt_file is not a regular file: ${resolved}`);
	if (info.size > MAX_SYSTEM_PROMPT_BYTES) throw new Error(`system_prompt_file exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
	const bytes = await readFile(resolved);
	new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return bytes;
}

function createClonedSessionBeforeLatestUser(ctx: ExtensionContext): string {
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!ctx.sessionManager.isPersisted() || !sourceSessionFile) throw new Error("clone context requires a persisted parent session");
	const branch = ctx.sessionManager.getBranch();
	let latestUserIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry: any = branch[index];
		if (entry?.type === "message" && entry.message?.role === "user") { latestUserIndex = index; break; }
	}
	if (latestUserIndex < 0) throw new Error("clone context could not find the current user message");
	const cloneLeafId = (branch[latestUserIndex - 1] as any)?.id;
	const source = SessionManager.open(sourceSessionFile, ctx.sessionManager.getSessionDir());
	if (!cloneLeafId) {
		const manager = (SessionManager.create as any)(ctx.cwd, ctx.sessionManager.getSessionDir(), { parentSession: sourceSessionFile }) as SessionManager;
		return manager.getSessionFile()!;
	}
	const cloned = source.createBranchedSession(cloneLeafId);
	if (!cloned) throw new Error("failed to create cloned subagent session");
	return cloned;
}

async function prepareAgent(
	spec: StartSpec,
	ctx: ExtensionContext,
	promptBuilder: (task: string, sandboxDir: string, transcript?: string) => string,
	idPrefix = "sa",
): Promise<PreparedAgent> {
	const model = exactModel(ctx, spec.model);
	validateThinking(model, spec.thinking);
	const contextMode = spec.context ?? "fresh";
	const id = `${idPrefix}-${randomUUID().slice(0, 8)}`;
	const sandboxDir = path.join(tmpdir(), "pi-subagents", id);
	let sessionFile: string | undefined;
	try {
		await mkdir(sandboxDir, { recursive: true });
		const systemPromptBytes = await readSystemPrompt(spec, ctx.cwd);
		const systemPromptPath = systemPromptBytes ? path.join(sandboxDir, "SUBAGENT_SYSTEM_PROMPT.md") : undefined;
		if (systemPromptPath) await writeFile(systemPromptPath, systemPromptBytes!);
		const parentSession = ctx.sessionManager.isPersisted() ? ctx.sessionManager.getSessionFile() : undefined;
		sessionFile = contextMode === "clone"
			? createClonedSessionBeforeLatestUser(ctx)
			: ((SessionManager.create as any)(ctx.cwd, ctx.sessionManager.getSessionDir(), { parentSession }) as SessionManager).getSessionFile()!;
		const childSession = SessionManager.open(sessionFile, ctx.sessionManager.getSessionDir());
		childSession.appendSessionInfo(`[Subagent ${id}] ${sanitizeTitle(spec.title)}`);
		const transcript = contextMode === "transcript" ? buildConversationTranscript(ctx.sessionManager.getBranch(), true).text : undefined;
		if (contextMode === "transcript" && !transcript) throw new Error("transcript context was requested, but there is no completed parent conversation before the current turn");
		const serialized: SerializedAgent = {
			id,
			title: sanitizeTitle(spec.title),
			task: cleanText(spec.task),
			modelRef: modelRef(model),
			thinking: spec.thinking,
			contextMode,
			sessionFile,
			sandboxDir,
			systemPromptPath,
			promptCacheKey: contextMode === "clone" ? ctx.sessionManager.getSessionId() : undefined,
			createdAt: Date.now(),
			runNumber: 0,
		};
		return { record: newRecord(serialized), prompt: promptBuilder(serialized.task, sandboxDir, transcript) };
	} catch (error) {
		await Promise.all([
			rm(sandboxDir, { recursive: true, force: true }).catch(() => {}),
			sessionFile ? unlink(sessionFile).catch(() => {}) : Promise.resolve(),
		]);
		throw error;
	}
}

async function cleanupPreparedAgents(prepared: PreparedAgent[]): Promise<void> {
	await Promise.all(prepared.flatMap(({ record }) => [
		rm(record.sandboxDir, { recursive: true, force: true }).catch(() => {}),
		unlink(record.sessionFile).catch(() => {}),
	]));
}

function genericPrompt(task: string, sandboxDir: string, transcript?: string): string {
	return [
		transcript ? `<main_session_transcript>\n${transcript}\n</main_session_transcript>\n` : "",
		"You are a managed Pi subagent. Complete the assigned task independently.",
		`Your scratch sandbox is: ${sandboxDir}`,
		"Use the sandbox for temporary files. Do not treat the project cwd as scratch space.",
		"Do not make durable project changes unless the task explicitly asks for them.",
		"Return a concise, self-contained final answer. The parent can continue this same session later if follow-up context is useful.",
		"",
		"<task>",
		task,
		"</task>",
	].filter(Boolean).join("\n");
}

const REVIEW_RUBRIC = `# Review Guidelines

You are acting as an independent code reviewer. The caller will provide the code review target separately.

## What to flag

Flag issues that:
1. Meaningfully affect correctness, robustness, data safety, security, performance, maintainability, or user-visible behavior.
2. Are discrete, actionable, and specific.
3. Are within the reviewed scope and not unrelated pre-existing issues.
4. The author would likely fix if they understood the issue.
5. Are supported by concrete code evidence, not speculation.
6. Do not demand rigor inconsistent with the rest of the codebase.
7. Are not merely style preferences unless they obscure meaning or violate explicit project standards.

Do not report unrelated pre-existing issues. Do not assume a bug exists; prove the failing path from code.

## Review method

1. Inspect the full relevant file/diff set before drawing conclusions.
2. Read enough surrounding code to understand intent, call flow, data ownership, and lifecycle boundaries.
3. Treat tests as supporting evidence only; passing tests do not prove correctness.
4. Pay special attention to:
   - error handling and recovery paths
   - persistence, migration, cleanup, and destructive operations
   - stale state, race/order problems, duplicate execution, and idempotence
   - security boundaries and untrusted input
   - performance, backpressure, and resource usage
   - compatibility with project conventions and documented policies
5. Prefer concrete bugs over broad rewrites.
6. Do not implement fixes unless explicitly asked; this is review only.

## Priority tags

Use exactly one priority tag for each finding title:

- [P0] Critical. Blocks release/use immediately; broad data loss, security compromise, or total breakage.
- [P1] High. Should be fixed before merge/use; likely bug, data-loss risk, serious lifecycle issue, or major regression.
- [P2] Medium. Real issue that should be fixed, but not necessarily blocking all use.
- [P3] Low. Minor but actionable issue, maintainability concern, or useful test gap.

Use [P0] sparingly.

## Finding format

Each finding should be concise and structured like this:

### [P1] Short problem title

Location: \`path/to/file.ext:line\` or \`path/to/file.ext:line-line\`

Explain what changed, why it is wrong or risky, the concrete scenario where it fails, and the likely fix direction. Keep each finding focused on one issue. Prefer short line ranges. If a code snippet is useful, keep it under 3 lines.

## Output format

Structure the final review exactly like this:

## Review Scope

Briefly state what you reviewed and any neutral focus provided by the caller.

## Summary

Short overall assessment.

## Findings

List findings in descending severity order.

If there are no qualifying findings, write:

- No blocking findings.

## Verification Notes

Mention commands or checks you ran. If you did not run tests, say so.

## Verdict

Choose one:

- \`correct\` — no blocking findings.
- \`needs attention\` — one or more findings should be addressed.

## Human Reviewer Callouts (Non-Blocking)

Include only applicable informational callouts. If none apply, write \`- (none)\`.

Possible callouts:
- **This change adds or changes persistence/storage format:** <details>
- **This change adds or changes migration/recovery behavior:** <details>
- **This change introduces a new dependency:** <details>
- **This change changes public API/config/schema/contract:** <details>
- **This change modifies auth/permission/security behavior:** <details>
- **This change includes destructive or irreversible operations:** <details>
- **This change has notable performance/backpressure implications:** <details>

## Tone and constraints

- Be direct, specific, and matter-of-fact.
- Avoid praise filler.
- Avoid nitpicks.
- Do not include speculative issues without a concrete failing path.
- Do not produce a full patch.
- Do not stop at the first issue; report every qualifying finding.
`;

function reviewPrompt(target: string, focus: string | undefined, sandboxDir: string, transcript?: string): string {
	return [
		transcript ? `<main_session_transcript>\n${transcript}\n</main_session_transcript>\n` : "",
		"You are a managed Pi code review subagent.",
		`Your scratch sandbox is: ${sandboxDir}`,
		"Do not make durable project changes. This is review only.",
		"Inspect the complete relevant code before reaching conclusions.",
		"",
		"<review_rubric>", REVIEW_RUBRIC, "</review_rubric>",
		"",
		"<review_target>", target, "</review_target>",
		focus ? `\n<neutral_focus>\n${focus}\n</neutral_focus>` : "",
	].filter(Boolean).join("\n");
}

function scanSerializedAgents(ctx: ExtensionContext): SerializedAgent[] {
	const byId = new Map<string, SerializedAgent>();
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		if (entry.message.toolName !== START_TOOL_NAME && entry.message.toolName !== REVIEW_TOOL_NAME) continue;
		const agents = entry.message.details?.agents;
		if (!Array.isArray(agents)) continue;
		for (const value of agents) {
			if (!isRecord(value)) continue;
			if (typeof value.id !== "string" || typeof value.sessionFile !== "string" || typeof value.modelRef !== "string") continue;
			if (!(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) continue;
			byId.set(value.id, value as unknown as SerializedAgent);
		}
	}
	return [...byId.values()];
}

function compactRecord(record: AgentRecord): Record<string, unknown> {
	return {
		id: record.id,
		title: record.title,
		state: record.state,
		lastOutcome: record.lastOutcome,
		model: record.modelRef,
		thinking: record.thinking,
		currentRunId: record.currentRunId,
		activity: currentActivity(record),
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		settledAt: record.settledAt,
		cost: record.usage.cost,
		turns: record.usage.turns,
		sessionFile: record.sessionFile,
	};
}

function formatList(records: AgentRecord[]): string {
	if (records.length === 0) return "No subagents are known in this parent session.";
	return records.map((record) => {
		const state = record.state === "cold" ? `cold; last run ${record.lastOutcome}` : record.state;
		return `${record.id} · ${state} · ${record.modelRef} [${record.thinking}] · ${record.title} · ${oneLine(currentActivity(record), 100)}`;
	}).join("\n");
}

function formatStatus(record: AgentRecord): string {
	const now = Date.now();
	const lines = [
		`${record.id} — ${record.title}`,
		`State: ${record.state}${record.state === "cold" ? `; last run ${record.lastOutcome}` : ""}`,
		`Model: ${record.modelRef}`,
		`Thinking: ${record.thinking}`,
		`Context: ${record.contextMode}`,
		record.currentRunId ? `Current/latest run: ${record.currentRunId}` : "",
		`Task: ${oneLine(record.currentTaskSummary ?? record.task, 180)}`,
	];
	if (record.activeTools.size > 0) {
		lines.push("Now:", ...[...record.activeTools.values()].map((tool) => `  - ${tool.description} (${formatDuration(now - tool.startedAt)})`));
	} else if (record.lastObservedAt) {
		lines.push(`Last observed ${formatDuration(now - record.lastObservedAt)} ago: ${record.recent.at(-1)?.text ?? record.lastOutcome}`, "No tool is currently known to be active.");
	}
	if (record.recent.length > 1) {
		lines.push("Recently:", ...record.recent.slice(-MAX_RECENT_ACTIVITIES).map((activity) => `  - ${activity.text}`));
	}
	const context = record.contextWindow ? ` · ${record.contextTokens === undefined ? "?" : formatTokens(record.contextTokens)}/${formatTokens(record.contextWindow)} context` : "";
	lines.push(`Usage: ${formatCost(record.usage.cost)} · ${record.usage.turns} model turn${record.usage.turns === 1 ? "" : "s"}${context}`);
	if (record.error) lines.push(`Error: ${oneLine(record.error, 300)}`);
	lines.push(`Session: ${record.sessionFile}`);
	return lines.filter(Boolean).join("\n");
}

function formatCompletion(records: AgentRecord[]): string {
	return records.map((record) => {
		const duration = record.startedAt && record.settledAt ? formatDuration(record.settledAt - record.startedAt) : "unknown time";
		const completed = record.lastOutcome === "completed";
		const preview = oneLine(completed ? (record.finalAnswer || "No final answer") : (record.error || "No final answer"), 220);
		const next = completed
			? `Use ${RESULT_TOOL_NAME} with id ${record.id} for the complete final answer.`
			: `Use ${STATUS_TOOL_NAME} with id ${record.id} for details; the child session is preserved.`;
		return `${record.id} · ${record.title}\n${record.lastOutcome} · ${record.modelRef} [${record.thinking}] · ${duration} · ${formatCost(record.usage.cost)}\nPreview: ${preview}\n${next}`;
	}).join("\n\n");
}

function findRunResult(record: AgentRecord, requestedRunId?: string): { runId?: string; text: string } {
	const manager = SessionManager.open(record.sessionFile);
	const messages = manager.getBranch().filter((entry: any) => entry?.type === "message").map((entry: any) => entry.message);
	let selectedRun = requestedRunId;
	if (!selectedRun) {
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]?.role !== "user") continue;
			const candidate = runIdFromText(messageText(messages[index]));
			if (candidate) { selectedRun = candidate; break; }
		}
	}
	if (!selectedRun) return { text: finalAssistantText(messages) };
	let start = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user" && runIdFromText(messageText(messages[index])) === selectedRun) { start = index; break; }
	}
	if (start < 0) throw new Error(`Run ${selectedRun} was not found in ${record.id}`);
	let end = messages.length;
	for (let index = start + 1; index < messages.length; index++) {
		if (messages[index]?.role === "user" && runIdFromText(messageText(messages[index]))) { end = index; break; }
	}
	const runMessages = messages.slice(start + 1, end);
	const assistant = [...runMessages].reverse().find((message) => message?.role === "assistant" && assistantText(message));
	if (!assistant) throw new Error(`No assistant answer found for ${selectedRun}`);
	if (assistant.stopReason === "error" || assistant.errorMessage) throw new Error(assistant.errorMessage || `Run ${selectedRun} failed`);
	if (assistant.stopReason === "length") throw new Error(`Run ${selectedRun} stopped at the token limit before producing a complete answer`);
	if (assistant.stopReason !== "stop") {
		throw new Error(`No final assistant answer found for ${selectedRun}; the run was interrupted after a partial response`);
	}
	return { runId: selectedRun, text: assistantText(assistant) };
}

function transcriptText(record: AgentRecord): string {
	const manager = SessionManager.open(record.sessionFile);
	const lines: string[] = [`# ${record.title}`, ``, `Model: ${record.modelRef} [${record.thinking}]`, `Session: ${record.sessionFile}`, ``];
	for (const entry of manager.getBranch() as any[]) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") lines.push("## User", messageText(message), "");
		else if (message.role === "assistant") lines.push("## Assistant", assistantText(message) || "(no text)", "");
		else if (message.role === "toolResult") lines.push(`### Tool result: ${message.toolName}`, messageText(message), "");
	}
	return lines.join("\n");
}

function result(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

type DisplayAgent = {
	id: string;
	title: string;
	state: string;
	outcome: string;
	model: string;
	thinking: string;
	activity: string;
	cost: number;
	turns: number;
};

function resultText(value: any): string {
	if (!Array.isArray(value?.content)) return "";
	return value.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function displayAgent(value: unknown): DisplayAgent | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	return {
		id: value.id,
		title: typeof value.title === "string" ? value.title : "subagent",
		state: typeof value.state === "string" ? value.state : "accepted",
		outcome: typeof value.lastOutcome === "string" ? value.lastOutcome : "none",
		model: typeof value.model === "string" ? value.model : typeof value.modelRef === "string" ? value.modelRef : "",
		thinking: typeof value.thinking === "string" ? value.thinking : "",
		activity: typeof value.activity === "string" ? value.activity : "",
		cost: typeof value.cost === "number" ? value.cost : 0,
		turns: typeof value.turns === "number" ? value.turns : 0,
	};
}

function displayAgents(details: any): DisplayAgent[] {
	const source = Array.isArray(details?.displayAgents) ? details.displayAgents : Array.isArray(details?.agents) ? details.agents : details?.agent ? [details.agent] : [];
	return source.map(displayAgent).filter((agent): agent is DisplayAgent => agent !== undefined);
}

function displayState(agent: DisplayAgent): string {
	return agent.state === "cold" ? agent.outcome : agent.state;
}

function stateGlyph(state: string): string {
	if (state === "completed") return "✓";
	if (state === "running" || state === "starting") return "◐";
	if (state === "queued" || state === "accepted") return "…";
	if (state === "stopped") return "■";
	if (state === "failed") return "!";
	if (state === "interrupted" || state === "stopping") return "◆";
	return "·";
}

function styledState(state: string, theme: Theme): string {
	const text = `${stateGlyph(state)} ${state}`;
	if (state === "completed") return theme.fg("success", text);
	if (state === "failed") return theme.fg("error", text);
	if (state === "interrupted" || state === "stopped" || state === "stopping") return theme.fg("warning", text);
	if (state === "running" || state === "starting") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

function agentCounts(agents: DisplayAgent[]): string {
	const counts = new Map<string, number>();
	for (const agent of agents) {
		const state = displayState(agent);
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	const order = ["completed", "running", "starting", "queued", "accepted", "stopped", "interrupted", "failed", "none"];
	return order.filter((state) => counts.has(state)).map((state) => `${counts.get(state)} ${state}`).join(" · ");
}

function agentRows(agents: DisplayAgent[], theme: Theme, expanded: boolean, maxCollapsed = 4, showMoreHint = true): string {
	const shown = expanded ? agents : agents.slice(0, maxCollapsed);
	const rows = shown.map((agent) => {
		const state = displayState(agent);
		const activity = agent.activity && agent.activity !== state ? ` · ${theme.fg("dim", oneLine(agent.activity, 80))}` : "";
		const cost = agent.cost > 0 ? ` · ${theme.fg("dim", formatCost(agent.cost))}` : "";
		const model = expanded && agent.model ? `\n    ${theme.fg("dim", `${agent.model}${agent.thinking ? ` [${agent.thinking}]` : ""}`)}` : "";
		return `${styledState(state, theme)}  ${theme.fg("accent", agent.id)}  ${theme.fg("muted", oneLine(agent.title, 70))}${activity}${cost}${model}`;
	});
	if (!expanded && agents.length > shown.length && showMoreHint) rows.push(theme.fg("dim", `… ${agents.length - shown.length} more (${keyHint("app.tools.expand", "details")})`));
	return rows.join("\n");
}

function toolHeader(label: string, detail: string, theme: Theme, lastComponent?: unknown): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", theme.bold(label)) + (detail ? ` ${theme.fg("muted", detail)}` : ""));
	return component;
}

function agentSummaryResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown, verb = "Subagents"): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	const agents = displayAgents(resultValue?.details);
	if (options.isError || resultValue?.details?.error) {
		component.setText(theme.fg("error", `! ${oneLine(String(resultValue?.details?.error || resultText(resultValue) || "Tool failed"), 500)}`));
		return component;
	}
	if (agents.length === 0) {
		component.setText(resultText(resultValue));
		return component;
	}
	const hasFailure = agents.some((agent) => displayState(agent) === "failed");
	const prefix = options.isPartial
		? theme.fg("accent", `◐ ${verb}`)
		: hasFailure
			? theme.fg("warning", `◆ ${verb}`)
			: theme.fg("success", `✓ ${verb}`);
	const counts = agentCounts(agents);
	const totalCost = agents.reduce((sum, agent) => sum + agent.cost, 0);
	const summary = `${prefix}${counts ? ` · ${counts}` : ""}${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}`;
	component.setText(`${summary}\n${agentRows(agents, theme, options.expanded)}`);
	return component;
}

function textOrMarkdownResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown, preview = 260) {
	const text = resultText(resultValue);
	if (options.isError) {
		const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
		component.setText(theme.fg("error", `! ${oneLine(text || "Tool failed", 500)}`));
		return component;
	}
	if (options.expanded && !options.isPartial) return new Markdown(text, 0, 0, getMarkdownTheme());
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(options.isPartial ? theme.fg("accent", `◐ ${oneLine(text, preview)}`) : theme.fg("muted", oneLine(text, preview)));
	return component;
}

function idsFromHandleFileValue(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : isRecord(item) && typeof item.id === "string" ? item.id : "").filter(Boolean);
	if (isRecord(value) && Array.isArray(value.agents)) return idsFromHandleFileValue(value.agents);
	return [];
}

async function resolveIds(params: { ids?: string[]; input_file?: string }, cwd: string): Promise<string[]> {
	if (params.input_file !== undefined) {
		if (params.ids !== undefined) throw new Error("ids and input_file are mutually exclusive");
		const loaded = await readJsonFile(params.input_file, cwd);
		const ids = idsFromHandleFileValue(loaded.value);
		if (ids.length === 0) throw new Error("input_file did not contain any subagent handles");
		return [...new Set(ids)];
	}
	if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error("ids is required and must not be empty");
	return [...new Set(params.ids.map((id) => cleanText(id)).filter(Boolean))];
}

function buildMainInstructions(): string {
	return `Managed subagents:
- Do not launch subagents unless the user explicitly asks for delegated/subagent work or has already established that subagents should be used for the current task.
- Use ${START_TOOL_NAME} for ordinary delegated work. ${START_TOOL_NAME} returns immediately; continue useful work instead of polling.
- Every new subagent requires an exact provider/model-id and an explicit thinking level. Never inherit or guess either value from the main session.
- Before launching, the user must have established a clear contract for which exact model and thinking level to use for that task or class of tasks. If no such contract exists, ask the user before launching.
- A subagent's model and thinking level remain fixed for its lifetime. Create a new subagent to change either.
- Reuse an existing subagent with ${SEND_TOOL_NAME} only for a direct continuation or follow-up where its previous context is useful. Create a new subagent for unrelated work, independent verification, or a fresh opinion.
- Use ${STATUS_TOOL_NAME} only when current progress matters. Do not repeatedly poll. Status is compact and does not include transcripts or raw tool output.
- Use ${WAIT_TOOL_NAME} only when further work truly depends on completion. Cancelling a wait leaves unfinished subagents running.
- Use ${RESULT_TOOL_NAME} only for completed runs whose final answer is needed.
- ${STOP_TOOL_NAME} stops current work but preserves the child Pi session for later continuation.
- Multiple ${START_TOOL_NAME} calls in one assistant turn may run in parallel. For large programmatic launches, ${START_TOOL_NAME} accepts input_file by itself containing a JSON array of complete normal start requests.

Code review subagents:
- Use ${REVIEW_TOOL_NAME} for code reviews. It is intentionally blocking and injects the standard review rubric, which lets them know to not edit anything, among other things.
- Only launch review subagents when the user explicitly asks for them.
- If user specifies "non-blocking review subagents", then you must use the more generic subagents.
- Every reviewer entry requires an exact provider/model-id and explicit thinking level covered by the user's established model contract.
- Supply only a neutral review target and optional neutral focus. Do not bias reviewers with suspected findings unless the user explicitly asks to verify one.
- Synthesize reviewer answers, deduplicate findings, and call out disagreement or uncertainty.`;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const promptCacheKey = process.env[PROMPT_CACHE_ENV];
		if (!promptCacheKey || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		if (Object.hasOwn(payload, "prompt_cache_key")) return { ...payload, prompt_cache_key: promptCacheKey };
		if (Object.hasOwn(payload, "promptCacheKey")) return { ...payload, promptCacheKey };
	});

	// Managed children are workers, not orchestrators. Their prompts are supplied by the parent.
	if (process.env[MANAGED_CHILD_ENV] === "1") return;

	let manager: SubagentManager | undefined;
	let latestCtx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let completionFlushScheduled = false;
	let shuttingDown = false;

	const flushCompletions = () => {
		if (shuttingDown || !latestCtx?.isIdle() || !manager) return;
		const deliverable = manager.getDeliverable();
		if (deliverable.length === 0) return;
		const ids = deliverable.map((record) => record.id);
		pi.sendMessage({
			customType: "subagent-completions",
			content: `Background subagent completion${deliverable.length === 1 ? "" : "s"}:\n\n${formatCompletion(deliverable)}`,
			display: true,
			details: { agents: deliverable.map(compactRecord) },
		}, { deliverAs: "followUp", triggerTurn: true });
		manager.markDelivered(ids);
	};

	const scheduleCompletionFlush = () => {
		if (completionFlushScheduled || !latestCtx?.isIdle()) return;
		completionFlushScheduled = true;
		queueMicrotask(() => {
			completionFlushScheduled = false;
			flushCompletions();
		});
	};

	const ensureManager = (ctx: ExtensionContext): SubagentManager => {
		latestCtx = ctx;
		if (shuttingDown) throw new Error("Subagent extension is shutting down");
		if (manager) return manager;
		manager = new SubagentManager(ctx.cwd);
		manager.restore(scanSerializedAgents(ctx));
		unsubscribe = manager.subscribe((event) => {
			if (event.kind === "settled") scheduleCompletionFlush();
		});
		return manager;
	};

	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${buildMainInstructions()}` }));

	pi.registerTool({
		name: START_TOOL_NAME,
		label: "Start Subagent",
		description: "Start one managed same-cwd Pi subagent and return immediately. Exact provider/model-id and thinking are required. Alternatively supply input_file by itself containing a non-empty JSON array of complete normal start requests. Small launches return normal per-agent output; large handle lists spill to a file.",
		parameters: Type.Object({
			input_file: Type.Optional(Type.String({ description: "Alternative to inline fields. JSON file containing an array of complete subagent_start requests. Must be supplied by itself." })),
			title: Type.Optional(Type.String({ description: "Short human-readable subagent title. Required inline." })),
			task: Type.Optional(Type.String({ description: "Complete task for this subagent. Required inline." })),
			model: Type.Optional(Type.String({ description: "Required exact provider/model-id. Never inherited or loosely matched." })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Required explicit Pi thinking level." })),
			context: Type.Optional(StringEnum(CONTEXT_MODES, { description: "Context mode; defaults to fresh." })),
			system_prompt: Type.Optional(Type.String({ description: "Optional additional system prompt; fresh context only." })),
			system_prompt_file: Type.Optional(Type.String({ description: "Optional UTF-8 additional system prompt file; fresh context only." })),
		}, { additionalProperties: false }),
		async execute(_id, params: StartToolParams, signal, _onUpdate, ctx) {
			const prepared: PreparedAgent[] = [];
			let addedCount = 0;
			try {
				if (signal?.aborted) throw new Error("Subagent start aborted before preparation");
				const resolved = await resolveStartSpecs(params, ctx.cwd);
				// Validate the complete request before creating any child session files.
				for (const spec of resolved.specs) {
					const model = exactModel(ctx, spec.model);
					validateThinking(model, spec.thinking);
					await readSystemPrompt(spec, ctx.cwd);
				}
				for (const spec of resolved.specs) {
					if (signal?.aborted) throw new Error("Subagent start aborted during preparation");
					prepared.push(await prepareAgent(spec, ctx, genericPrompt));
				}
				if (signal?.aborted) throw new Error("Subagent start aborted during preparation");
				const activeManager = ensureManager(ctx);
				const records: AgentRecord[] = [];
				for (const item of prepared) {
					records.push(activeManager.add(item));
					addedCount++;
				}
				const serialized = records.map(serializeAgent);
				let text: string;
				let handlesFile: string | undefined;
				if (records.length <= NORMAL_LAUNCH_DETAIL_LIMIT) {
					text = `Started ${records.length} subagent${records.length === 1 ? "" : "s"}:\n\n${records.map((record) => `${record.id} · ${record.title}\n  ${record.modelRef} [${record.thinking}]\n  ${record.state} · session: ${record.sessionFile}`).join("\n\n")}`;
				} else {
					handlesFile = path.join(tmpdir(), `pi-subagent-handles-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
					const running = Math.min(records.length, MAX_CONCURRENT_SUBAGENTS);
					try {
						await writeFile(handlesFile, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
						text = `Accepted ${records.length} subagents.\nStarting/running: ${running}\nQueued internally: ${Math.max(0, records.length - running)}\nHandle list saved to: ${handlesFile}`;
					} catch (error) {
						handlesFile = undefined;
						text = `Accepted ${records.length} subagents.\nStarting/running: ${running}\nQueued internally: ${Math.max(0, records.length - running)}\nWarning: the compact handle file could not be written (${error instanceof Error ? error.message : String(error)}). Handles remain preserved in this tool result's details.`;
					}
				}
				if (resolved.manifest) text += `\nInput: ${resolved.manifest.path} · ${resolved.manifest.bytes.toLocaleString("en-US")} bytes · SHA-256 ${resolved.manifest.sha256}`;
				return result(text, { agents: serialized, displayAgents: records.map(compactRecord), handlesFile, manifest: resolved.manifest });
			} catch (error) {
				await cleanupPreparedAgents(prepared.slice(addedCount));
				throw new Error(`Subagents were not started: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const detail = typeof input?.input_file === "string"
				? `manifest ${path.basename(input.input_file)}`
				: `${oneLine(input?.title ?? "subagent", 60)}${input?.model ? ` · ${input.model}${input.thinking ? ` [${input.thinking}]` : ""}` : ""}`;
			return toolHeader("Start subagent", detail, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, options.isPartial ? "Starting" : "Accepted");
		},
	});

	pi.registerTool({
		name: LIST_TOOL_NAME,
		label: "List Subagents",
		description: "List managed subagents compactly. Does not return transcripts, raw tool output, or full final answers.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const records = ensureManager(ctx).list();
			const formatted = formatList(records);
			const truncated = truncateHead(formatted);
			return result(truncated.content, { agents: records.map(compactRecord), truncated: truncated.truncated });
		},
		renderCall(_args, theme, context) {
			return toolHeader("List subagents", "", theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, "Known");
		},
	});

	pi.registerTool({
		name: STATUS_TOOL_NAME,
		label: "Subagent Status",
		description: "Return accurate compact status for selected subagents: active tools, last observed activity, recent compact activity, usage, and session path. Never returns transcript or raw tool output.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const records = [...new Set(params.ids)].map((id) => ensureManager(ctx).get(id));
				return result(records.map(formatStatus).join("\n\n---\n\n"), { agents: records.map(compactRecord) });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const ids = Array.isArray((args as any)?.ids) ? (args as any).ids : [];
			return toolHeader("Subagent status", ids.length === 1 ? ids[0] : `${ids.length} agents`, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			if (options.expanded && !options.isPartial && !context.isError) return new Text(resultText(resultValue), 0, 0);
			return agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, "Status");
		},
	});

	pi.registerTool({
		name: SEND_TOOL_NAME,
		label: "Message Subagent",
		description: "Send a continuation to a cold subagent, steer a running subagent, or queue a running follow-up. Continuations use the subagent's fixed model and thinking level.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
			delivery: Type.Optional(StringEnum(["steer", "follow_up"] as const, { description: "For a running subagent: steer after current tool calls, or follow_up after it otherwise finishes. Defaults to steer." })),
		}),
		async execute(_toolId, params, _signal, _onUpdate, ctx) {
			try {
				const sent = await ensureManager(ctx).send(params.id, params.message, params.delivery ?? "steer");
				return result(sent.continued
					? `Continued ${sent.record.id} as ${sent.record.currentRunId} using ${sent.record.modelRef} [${sent.record.thinking}].`
					: `Message accepted by running ${sent.record.id} using ${sent.record.modelRef} [${sent.record.thinking}].`,
				{ agent: compactRecord(sent.record), runId: sent.record.currentRunId, continued: sent.continued });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const delivery = input?.delivery ?? "steer";
			const preview = input?.message ? ` · “${oneLine(input.message, 70)}”` : "";
			return toolHeader("Message subagent", `${input?.id ?? ""} · ${delivery}${preview}`, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			if (context.isError) return textOrMarkdownResult(resultValue, { ...options, isError: true }, theme, context.lastComponent);
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const agent = displayAgents(resultValue?.details)[0];
			const continued = resultValue?.details?.continued === true;
			component.setText(theme.fg("success", `✓ ${continued ? "Continuation queued" : "Message accepted"}`) + (agent ? ` · ${theme.fg("accent", agent.id)}${resultValue?.details?.runId ? ` · ${theme.fg("muted", resultValue.details.runId)}` : ""}` : ""));
			return component;
		},
	});

	const IdSelector = Type.Object({
		ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		input_file: Type.Optional(Type.String({ description: "Handle JSON file returned by a large subagent_start call. Mutually exclusive with ids." })),
	});

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: "Wait for Subagents",
		description: "Wait for selected subagents to become cold. Cancellation leaves unfinished subagents running. Returns compact outcomes, not final answers.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			input_file: Type.Optional(Type.String()),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const ids = await resolveIds(params, ctx.cwd);
				const activeManager = ensureManager(ctx);
				const waitController = new AbortController();
				let timedOut = false;
				const onAbort = () => waitController.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				const timeout = params.timeout_seconds === undefined ? undefined : setTimeout(() => {
					timedOut = true;
					waitController.abort();
				}, params.timeout_seconds * 1_000);
				const heartbeat = setInterval(() => {
					const records = ids.map((id) => activeManager.get(id));
					onUpdate?.(result(formatList(records), { agents: records.map(compactRecord) }));
				}, 1_000);
				try {
					const records = await activeManager.wait(ids, waitController.signal, true);
					return result(`Selected subagents settled:\n${formatList(records)}\n\nUse ${RESULT_TOOL_NAME} only for answers you need.`, { agents: records.map(compactRecord) });
				} catch (error) {
					if (!timedOut) throw error;
					const records = ids.map((id) => activeManager.get(id));
					return result(`Wait timed out; unfinished subagents are still running:\n${formatList(records)}`, { agents: records.map(compactRecord), timedOut: true });
				} finally {
					clearInterval(heartbeat);
					if (timeout) clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const count = Array.isArray(input?.ids) ? input.ids.length : undefined;
			const selected = count !== undefined ? `${count} agent${count === 1 ? "" : "s"}` : input?.input_file ? `manifest ${path.basename(input.input_file)}` : "agents";
			const timeout = input?.timeout_seconds ? ` · timeout ${formatDuration(input.timeout_seconds * 1_000)}` : "";
			return toolHeader("Wait for subagents", `${selected}${timeout}`, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			const verb = resultValue?.details?.timedOut ? "Wait timed out" : options.isPartial ? "Waiting" : "Settled";
			const rendered = agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, verb);
			if (resultValue?.details?.timedOut) {
				const agents = displayAgents(resultValue?.details);
				rendered.setText(`${theme.fg("warning", `◷ Wait timed out · ${agentCounts(agents)}`)}\n${agentRows(agents, theme, options.expanded)}`);
			}
			return rendered;
		},
	});

	pi.registerTool({
		name: RESULT_TOOL_NAME,
		label: "Read Subagent Result",
		description: "Read the final assistant answer for one subagent run. Status and list intentionally omit full answers.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1 }),
			run_id: Type.Optional(Type.String({ minLength: 1, description: "Specific run ID. Omit for the latest run." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const record = ensureManager(ctx).get(params.id);
				const found = findRunResult(record, params.run_id);
				if (!found.text) throw new Error(`${record.id}${found.runId ? ` ${found.runId}` : ""} has no final assistant answer.`);
				const truncated = truncateHead(found.text);
				let text = `${record.id}${found.runId ? ` · ${found.runId}` : ""}\n${record.modelRef} [${record.thinking}]\n\n${truncated.content}`;
				if (truncated.truncated) text += `\n\n[Result truncated. The complete answer remains in ${record.sessionFile}]`;
				return result(text, { agent: compactRecord(record), runId: found.runId, truncated: truncated.truncated });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			return toolHeader("Subagent result", `${input?.id ?? ""}${input?.run_id ? ` · ${input.run_id}` : " · latest"}`, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			if (context.isError || options.expanded) return textOrMarkdownResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, 320);
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const agent = displayAgents(resultValue?.details)[0];
			const runId = typeof resultValue?.details?.runId === "string" ? resultValue.details.runId : "latest";
			const heading = theme.fg("success", "✓ Final answer") + (agent ? ` · ${theme.fg("accent", agent.id)}` : "") + ` · ${theme.fg("muted", runId)}`;
			const raw = resultText(resultValue);
			const answer = raw.includes("\n\n") ? raw.slice(raw.indexOf("\n\n") + 2) : raw;
			component.setText(`${heading}\n${theme.fg("muted", oneLine(answer, 320))}`);
			return component;
		},
	});

	pi.registerTool({
		name: STOP_TOOL_NAME,
		label: "Stop Subagents",
		description: "Stop selected queued or running subagents while preserving their normal Pi session files for later continuation.",
		parameters: IdSelector,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const ids = await resolveIds(params, ctx.cwd);
				const records = await ensureManager(ctx).stop(ids);
				return result(`Stop requested:\n${formatList(records)}`, { agents: records.map(compactRecord) });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const count = Array.isArray(input?.ids) ? input.ids.length : undefined;
			const detail = count !== undefined ? `${count} agent${count === 1 ? "" : "s"}` : input?.input_file ? `manifest ${path.basename(input.input_file)}` : "agents";
			return toolHeader("Stop subagents", detail, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, "Stopped");
		},
	});

	pi.registerTool({
		name: REVIEW_TOOL_NAME,
		label: "Launch Code Review Subagents",
		description: "Launch independent code review subagents through the shared manager, wait for all reviewers, and return their structured answers. This operation is intentionally blocking. Every reviewer requires an exact provider/model-id and explicit thinking level.",
		parameters: Type.Object({
			input_file: Type.Optional(Type.String({ description: "Alternative to inline fields. Existing review manifest object. Must be supplied by itself." })),
			what_to_review: Type.Optional(Type.String({ description: "Neutral code review target. Required inline." })),
			context: Type.Optional(StringEnum(CONTEXT_MODES)),
			system_prompt: Type.Optional(Type.String()),
			system_prompt_file: Type.Optional(Type.String()),
			reviewers: Type.Optional(Type.Array(Type.Object({
				description: Type.String({ minLength: 1 }),
				focus: Type.Optional(Type.String()),
				model: Type.String({ minLength: 1, description: "Required exact provider/model-id." }),
				thinking: StringEnum(THINKING_LEVELS, { description: "Required explicit thinking level." }),
			}, { additionalProperties: false }), { minItems: 1 })),
		}, { additionalProperties: false }),
		async execute(_id, rawParams: ReviewToolParams, signal, onUpdate, ctx) {
			const prepared: PreparedAgent[] = [];
			let addedCount = 0;
			try {
				let params: ReviewParams;
				let manifest: LaunchManifestMetadata | undefined;
				if (rawParams.input_file !== undefined) {
					if (Object.keys(rawParams).some((key) => key !== "input_file")) throw new Error("input_file must be supplied by itself");
					const loaded = await readJsonFile(rawParams.input_file, ctx.cwd);
					if (!isRecord(loaded.value)) throw new Error("Review manifest must be an object");
					params = loaded.value as unknown as ReviewParams;
					manifest = { ...loaded.metadata, entries: Array.isArray((loaded.value as any).reviewers) ? (loaded.value as any).reviewers.length : 0 };
				} else params = rawParams as ReviewParams;
				if (typeof params.what_to_review !== "string" || !cleanText(params.what_to_review)) throw new Error("what_to_review is required");
				if (!Array.isArray(params.reviewers) || params.reviewers.length === 0) throw new Error("reviewers is required and must not be empty");
				if (params.context !== undefined && !(CONTEXT_MODES as readonly unknown[]).includes(params.context)) throw new Error(`Invalid context: ${String(params.context)}`);
				if (params.system_prompt !== undefined && params.system_prompt_file !== undefined) throw new Error("system_prompt and system_prompt_file are mutually exclusive");
				if ((params.system_prompt !== undefined || params.system_prompt_file !== undefined) && params.context !== undefined && params.context !== "fresh") throw new Error("custom system prompts require fresh context");
				const target = cleanText(params.what_to_review);
				// Validate every reviewer before creating any child session files.
				for (const [index, reviewer] of params.reviewers.entries()) {
					if (signal?.aborted) throw new Error("Code review launch aborted during preparation");
					if (!isRecord(reviewer) || typeof reviewer.description !== "string" || !cleanText(reviewer.description)) throw new Error(`reviewers[${index}].description is required`);
					if (typeof reviewer.model !== "string" || !cleanText(reviewer.model)) throw new Error(`reviewers[${index}].model is required and must be exact provider/model-id`);
					if (!(THINKING_LEVELS as readonly unknown[]).includes(reviewer.thinking)) throw new Error(`reviewers[${index}].thinking is required`);
					const model = exactModel(ctx, reviewer.model);
					validateThinking(model, reviewer.thinking);
				}
				await readSystemPrompt({ system_prompt: params.system_prompt, system_prompt_file: params.system_prompt_file }, ctx.cwd);
				for (const [index, reviewer] of params.reviewers.entries()) {
					if (signal?.aborted) throw new Error("Code review launch aborted during preparation");
					if (!isRecord(reviewer) || typeof reviewer.description !== "string" || !cleanText(reviewer.description)) throw new Error(`reviewers[${index}].description is required`);
					if (typeof reviewer.model !== "string" || !cleanText(reviewer.model)) throw new Error(`reviewers[${index}].model is required and must be exact provider/model-id`);
					if (!(THINKING_LEVELS as readonly unknown[]).includes(reviewer.thinking)) throw new Error(`reviewers[${index}].thinking is required`);
					const spec: StartSpec = {
						title: `[Review] ${reviewer.description}`,
						task: target,
						model: reviewer.model,
						thinking: reviewer.thinking,
						context: params.context,
						system_prompt: params.system_prompt,
						system_prompt_file: params.system_prompt_file,
					};
					prepared.push(await prepareAgent(spec, ctx, (_task, sandbox, transcript) => reviewPrompt(target, cleanText(reviewer.focus || "") || undefined, sandbox, transcript), "review"));
				}
				if (signal?.aborted) throw new Error("Code review launch aborted during preparation");
				const activeManager = ensureManager(ctx);
				const records: AgentRecord[] = [];
				for (const item of prepared) {
					records.push(activeManager.add(item));
					addedCount++;
				}
				const heartbeat = setInterval(() => onUpdate?.(result(formatList(records), { agents: records.map(compactRecord) })), 500);
				try {
					await activeManager.wait(records.map((record) => record.id), signal, true);
				} catch (error) {
					if (signal?.aborted) await activeManager.stop(records.map((record) => record.id));
					throw error;
				} finally { clearInterval(heartbeat); }
				const answers = records.map((record, index) => {
					let answer = record.finalAnswer || record.error || "(No final answer.)";
					try { answer = findRunResult(record).text || answer; } catch {}
					const duration = record.startedAt && record.settledAt ? formatDuration(record.settledAt - record.startedAt) : "unknown";
					return `---\n\n## Reviewer ${index + 1} — ${record.title}\n\n> ${record.id} · ${record.modelRef} [${record.thinking}] · ${record.lastOutcome}\n\n- **Attempts / model turns / duration:** ${record.attempt} · ${record.usage.turns} · ${duration}\n- **Tokens:** ${totalUsageTokens(record.usage).toLocaleString("en-US")} total (input ${record.usage.input.toLocaleString("en-US")} · output ${record.usage.output.toLocaleString("en-US")} · cache read ${record.usage.cacheRead.toLocaleString("en-US")} · cache write ${record.usage.cacheWrite.toLocaleString("en-US")})\n- **Exact cost:** ${formatCost(record.usage.cost)}\n- **Session:** ${record.sessionFile}\n\n${answer}`;
				});
				const failures = records.filter((record) => record.lastOutcome !== "completed").length;
				const totalCost = records.reduce((sum, record) => sum + record.usage.cost, 0);
				const totalTokens = records.reduce((sum, record) => sum + totalUsageTokens(record.usage), 0);
				const header = `# Review Subagent Results\n\nReviewers: ${records.length} · failures: ${failures}\nTokens: ${totalTokens.toLocaleString("en-US")} · total cost: ${formatCost(totalCost)}${manifest ? `\nManifest: ${manifest.path}` : ""}`;
				const fullReview = [header, ...answers, "---", FINAL_RESULT_DISCLAIMER].join("\n\n");
				const truncated = truncateHead(fullReview);
				let reviewFile: string | undefined;
				let reviewText = truncated.content;
				if (truncated.truncated) {
					reviewFile = path.join(tmpdir(), `pi-review-subagents-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
					try {
						await writeFile(reviewFile, fullReview, "utf8");
						reviewText += `\n\n[Combined review output truncated. Full output saved to: ${reviewFile}]`;
					} catch (error) {
						reviewFile = undefined;
						reviewText += `\n\n[Combined review output truncated. The complete reviewer answers remain in their child sessions. Could not write a combined artifact: ${error instanceof Error ? error.message : String(error)}]`;
					}
				}
				return result(reviewText, { agents: records.map(serializeAgent), displayAgents: records.map(compactRecord), failures, totalCost, totalTokens, manifest, reviewFile, truncated: truncated.truncated });
			} catch (error) {
				await cleanupPreparedAgents(prepared.slice(addedCount));
				throw new Error(`Code review subagents failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const count = Array.isArray(input?.reviewers) ? input.reviewers.length : 0;
			const detail = input?.input_file ? `manifest ${path.basename(input.input_file)}` : `${count} reviewer${count === 1 ? "" : "s"} · ${oneLine(input?.what_to_review ?? "code review", 80)}`;
			return toolHeader("Code review", detail, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			if (context.isError) return textOrMarkdownResult(resultValue, { ...options, isError: true }, theme, context.lastComponent);
			if (options.expanded && !options.isPartial) return new Markdown(resultText(resultValue), 0, 0, getMarkdownTheme());
			const agents = displayAgents(resultValue?.details);
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const failures = Number(resultValue?.details?.failures ?? agents.filter((agent) => displayState(agent) === "failed").length);
			const totalCost = Number(resultValue?.details?.totalCost ?? agents.reduce((sum, agent) => sum + agent.cost, 0));
			const totalTokens = Number(resultValue?.details?.totalTokens ?? 0);
			const headline = options.isPartial
				? theme.fg("accent", `◐ Reviewing · ${agentCounts(agents)}`)
				: failures > 0
					? theme.fg("warning", `◆ Review complete · ${failures} failed`)
					: theme.fg("success", `✓ Review complete · ${agents.length} reviewer${agents.length === 1 ? "" : "s"}`);
			const metrics = `${totalTokens > 0 ? ` · ${totalTokens.toLocaleString("en-US")} tokens` : ""}${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}`;
			component.setText(`${headline}${metrics}${agents.length ? `\n${agentRows(agents, theme, false, 5, false)}` : ""}${agents.length > 5 ? `\n${theme.fg("dim", `… ${agents.length - 5} more`)}` : ""}${!options.isPartial ? `\n${theme.fg("dim", keyHint("app.tools.expand", "full review"))}` : ""}`);
			return component;
		},
	});

	pi.registerMessageRenderer("subagent-completions", (message, options, theme) => {
		const agents = displayAgents(message.details);
		if (options.expanded || agents.length === 0) return new Text(theme.fg("accent", theme.bold(agents.length === 1 ? "Subagent completion" : "Subagent completions")) + `\n${String(message.content)}`, 0, 0);
		const completed = agents.filter((agent) => displayState(agent) === "completed").length;
		const exceptional = agents.length - completed;
		const totalCost = agents.reduce((sum, agent) => sum + agent.cost, 0);
		const title = completed === agents.length
			? theme.fg("success", `✓ ${agents.length} subagent${agents.length === 1 ? "" : "s"} completed`)
			: theme.fg("warning", `◆ ${agents.length} subagent update${agents.length === 1 ? "" : "s"} · ${exceptional} exceptional`);
		return new Text(`${title}${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}\n${agentRows(agents, theme, false, 4)}`, 0, 0);
	});

	pi.registerCommand("subagents", {
		description: "Inspect and interact with managed subagents",
		handler: async (_args, ctx) => {
			const activeManager = ensureManager(ctx);
			if (!ctx.hasUI) return;
			while (true) {
				const records = activeManager.list();
				if (records.length === 0) { ctx.ui.notify("No subagents are known in this parent session.", "info"); return; }
				const choices = records.map((record) => `${record.id} · ${record.state === "cold" ? `cold/${record.lastOutcome}` : record.state} · ${record.title} · ${record.modelRef} [${record.thinking}]`);
				const selected = await ctx.ui.select("Managed subagents", choices);
				if (!selected) return;
				const id = selected.split(" · ")[0]!;
				const record = activeManager.get(id);
				const action = await ctx.ui.select(`${record.id} — ${record.title}`, ["View status", "View transcript", "Send message", "Stop", "Show native session command", "Back"]);
				if (!action || action === "Back") continue;
				if (action === "View status") await ctx.ui.editor(`${record.id} status`, formatStatus(record));
				else if (action === "View transcript") await ctx.ui.editor(`${record.id} transcript (read-only; edits are discarded)`, transcriptText(record));
				else if (action === "Send message") {
					const message = await ctx.ui.editor(`Message ${record.id}`, "");
					if (message?.trim()) {
						await activeManager.send(record.id, message, "follow_up");
						ctx.ui.notify(`Message sent to ${record.id}.`, "info");
					}
				} else if (action === "Stop") {
					await activeManager.stop([record.id]);
					ctx.ui.notify(`Stop requested for ${record.id}.`, "info");
				} else if (action === "Show native session command") {
					const command = `pi --session ${JSON.stringify(record.sessionFile)}`;
					await ctx.ui.editor("Native Pi command (copy this; edits are discarded)", command);
					ctx.ui.notify("Stop the managed subagent before opening the same session in another Pi process.", "warning");
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		ensureManager(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		flushCompletions();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		unsubscribe?.();
		unsubscribe = undefined;
		const active = manager;
		manager = undefined;
		if (active) await active.dispose();
	});
}
