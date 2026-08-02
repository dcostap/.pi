import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildConversationTranscript } from "../_shared/conversation-transcript.ts";
import { formatCompletionBatch, type CompletionSnapshot } from "./completion.ts";
import { loadSubagentProfiles, type SubagentProfile } from "./profiles.ts";
import { applyRuntimeStatusEvent } from "./runtime-events.ts";
import { buildVisibleTree } from "./tree.ts";

const LEGACY_REVIEW_TOOL_NAME = "launch_review_subagents";
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
const NESTED_SUBAGENTS_ENABLED = false;

const WIDGET_ID = "subagents-tree";
const MAX_WIDGET_NODES = 12;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ContextMode = (typeof CONTEXT_MODES)[number];
type AgentRuntimeState = "queued" | "starting" | "running" | "stopping" | "cold";
type RunOutcome = "none" | "completed" | "failed" | "stopped" | "interrupted";
type DeliveryMode = "steer" | "follow_up";
type WaitMode = "all" | "any";

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
	profile?: string;
	context?: ContextMode;
	system_prompt?: string;
	system_prompt_file?: string;
};

type StartToolParams = Partial<StartSpec> & {
	input_file?: string;
};

type SerializedAgent = {
	id: string;
	title: string;
	task: string;
	modelRef: string;
	thinking: ThinkingLevel;
	profile?: string;
	parentAgentId?: string;
	contextMode: ContextMode;
	sessionFile: string;
	sandboxDir: string;
	systemPromptPath?: string;
	promptCacheKey?: string;
	createdAt: number;
	runNumber: number;
	contextWindow?: number;
	// Runtime fields recovered from later parent-session tool results. Older
	// launch records do not contain these fields.
	restoredOutcome?: RunOutcome;
	restoredRunId?: string;
	restoredStartedAt?: number;
	restoredSettledAt?: number;
	restoredAttempt?: number;
	restoredUsage?: UsageStats;
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
	latestCompletion?: CompletionSnapshot;
};

type PreparedAgent = {
	record: AgentRecord;
	prompt: string;
};

type ManagerEvent =
	| { kind: "changed"; id: string }
	| { kind: "settled"; id: string };

type WaitResult = {
	mode: WaitMode;
	selected: AgentRecord[];
	settled: AgentRecord[];
	pending: AgentRecord[];
};

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

function modelContextWindow(ctx: ExtensionContext, raw: string): number | undefined {
	const requested = cleanText(raw);
	const slash = requested.indexOf("/");
	if (slash <= 0 || slash === requested.length - 1) return undefined;
	const model = ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1)) as Model<any> | undefined;
	return typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
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
		profile: record.profile,
		parentAgentId: record.parentAgentId,
		contextMode: record.contextMode,
		sessionFile: record.sessionFile,
		sandboxDir: record.sandboxDir,
		systemPromptPath: record.systemPromptPath,
		promptCacheKey: record.promptCacheKey,
		createdAt: record.createdAt,
		runNumber: record.runNumber,
		contextWindow: record.contextWindow,
	};
}

function completionSnapshot(record: AgentRecord): CompletionSnapshot {
	const settledAt = record.settledAt ?? Date.now();
	return {
		id: record.id,
		title: record.title,
		parentAgentId: record.parentAgentId,
		profile: record.profile,
		outcome: record.lastOutcome,
		model: record.modelRef,
		thinking: record.thinking,
		runId: record.currentRunId,
		task: record.currentTaskSummary ?? record.task,
		activity: currentActivity(record),
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		settledAt,
		durationMs: record.startedAt ? Math.max(0, settledAt - record.startedAt) : undefined,
		attempts: record.attempt,
		usage: { ...record.usage },
		contextWindow: record.contextWindow,
		contextTokens: record.contextTokens,
		finalAnswer: record.finalAnswer,
		error: record.error,
		sessionFile: record.sessionFile,
	};
}

function newRecord(serialized: SerializedAgent): AgentRecord {
	return {
		...serialized,
		state: "cold",
		lastOutcome: serialized.restoredOutcome ?? "none",
		currentRunId: serialized.restoredRunId,
		startedAt: serialized.restoredStartedAt,
		settledAt: serialized.restoredSettledAt,
		updatedAt: serialized.restoredSettledAt ?? serialized.createdAt,
		activeTools: new Map(),
		recent: [],
		usage: serialized.restoredUsage ? { ...emptyUsage(), ...serialized.restoredUsage } : emptyUsage(),
		finalAnswer: "",
		attempt: serialized.restoredAttempt ?? 0,
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
		let latestRunId: string | undefined = record.currentRunId;
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
		if (record.lastOutcome === "none") {
			record.lastOutcome = "failed";
			record.error = `Could not open child session: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const stoppedRunStillLatest = record.restoredOutcome === "stopped"
		&& (!record.restoredRunId || !record.currentRunId || record.restoredRunId === record.currentRunId);
	if (stoppedRunStillLatest) {
		record.lastOutcome = "stopped";
		record.error = undefined;
	} else if (record.restoredOutcome === "stopped") {
		// A later continuation supersedes the historical stop marker.
		record.restoredOutcome = undefined;
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
		record.startedAt = undefined;
		record.settledAt = undefined;
		record.latestCompletion = undefined;
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

	async wait(ids: string[], signal: AbortSignal | undefined, consumeDelivery: boolean, mode: WaitMode): Promise<WaitResult> {
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
			const completion = mode === "any"
				? Promise.race(records.map((record) => record.completion ?? Promise.resolve()))
				: Promise.all(records.map((record) => record.completion ?? Promise.resolve()));
			await Promise.race([completion, abortPromise]);
			const settled = mode === "any" ? records.filter((record) => record.state === "cold") : records;
			const pending = records.filter((record) => !settled.includes(record));
			if (consumeDelivery) {
				for (const record of settled) {
					record.deliveryConsumed = true;
					record.deliveryPending = false;
				}
			}
			completed = true;
			return { mode, selected: records, settled, pending };
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
				record.latestCompletion = completionSnapshot(record);
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
			if (this.get(record.id).state !== "cold") await record.client?.terminate();
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
		record.latestCompletion = completionSnapshot(record);
		record.resolveCompletion?.();
		record.resolveCompletion = undefined;
		this.emit({ kind: "settled", id: record.id });
	}

	private applyEvent(record: AgentRecord, event: any): void {
		const now = Date.now();
		record.updatedAt = now;
		record.lastObservedAt = now;
		const runtimeActivity = applyRuntimeStatusEvent(record, event);
		if (runtimeActivity) addActivity(record, runtimeActivity, now);
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
	const allowed = new Set(["title", "task", "model", "thinking", "profile", "context", "system_prompt", "system_prompt_file"]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}.${key}: unknown property`);
	for (const key of ["title", "task", "model"] as const) {
		if (typeof value[key] !== "string" || !cleanText(value[key] as string)) errors.push(`${location}.${key}: required non-empty string`);
	}
	if (!(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) errors.push(`${location}.thinking: required; expected one of ${THINKING_LEVELS.join(", ")}`);
	if (value.profile !== undefined && (typeof value.profile !== "string" || !cleanText(value.profile))) errors.push(`${location}.profile: expected non-empty string`);
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

function exactProfile(profiles: Map<string, SubagentProfile>, raw: string | undefined): SubagentProfile | undefined {
	if (raw === undefined) return undefined;
	const name = cleanText(raw);
	const profile = profiles.get(name);
	if (!profile) throw new Error(`Unknown subagent profile ${JSON.stringify(name)}. Available: ${[...profiles.keys()].join(", ") || "none"}`);
	return profile;
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
			profile: spec.profile,
			contextMode,
			sessionFile,
			sandboxDir,
			systemPromptPath,
			promptCacheKey: contextMode === "clone" ? ctx.sessionManager.getSessionId() : undefined,
			createdAt: Date.now(),
			runNumber: 0,
			contextWindow: model.contextWindow,
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

function genericPrompt(task: string, sandboxDir: string, transcript?: string, profile?: SubagentProfile): string {
	return [
		transcript ? `<main_session_transcript>\n${transcript}\n</main_session_transcript>\n` : "",
		"You are a managed Pi subagent. Complete the assigned task independently.",
		`Your scratch sandbox is: ${sandboxDir}`,
		"Use the sandbox for temporary files. Do not treat the project cwd as scratch space.",
		"Do not make durable project changes unless the task explicitly asks for them.",
		"Return a concise, self-contained final answer. The parent can continue this same session later if follow-up context is useful.",
		profile ? `\n<subagent_profile name="${profile.name}">\n${profile.prompt}\n</subagent_profile>` : "",
		"",
		"<task>",
		task,
		"</task>",
	].filter(Boolean).join("\n");
}

function scanSerializedAgents(ctx: ExtensionContext): SerializedAgent[] {
	const byId = new Map<string, SerializedAgent>();
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		const toolName = entry.message.toolName;
		const agents = entry.message.details?.agents;
		if (!Array.isArray(agents)) continue;
		const isLaunch = toolName === START_TOOL_NAME || toolName === LEGACY_REVIEW_TOOL_NAME;
		for (const value of agents) {
			if (!isRecord(value)) continue;
			if (typeof value.id !== "string") continue;
			if (isLaunch) {
				if (typeof value.sessionFile !== "string" || typeof value.modelRef !== "string") continue;
				if (!(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) continue;
				byId.set(value.id, value as unknown as SerializedAgent);
				continue;
			}
			const existing = byId.get(value.id);
			if (!existing || toolName !== STOP_TOOL_NAME || value.lastOutcome !== "stopped") continue;
			byId.set(value.id, {
				...existing,
				restoredOutcome: "stopped",
				restoredRunId: typeof value.currentRunId === "string" ? value.currentRunId : existing.restoredRunId,
				restoredSettledAt: typeof value.settledAt === "number" ? value.settledAt : existing.restoredSettledAt,
			});
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
		profile: record.profile,
		parentAgentId: record.parentAgentId,
		currentRunId: record.currentRunId,
		activity: currentActivity(record),
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		settledAt: record.settledAt,
		cost: record.usage.cost,
		turns: record.usage.turns,
		tokens: totalUsageTokens(record.usage),
		contextWindow: record.contextWindow,
		contextTokens: record.contextTokens,
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
		record.profile ? `Profile: ${record.profile}` : "",
		record.parentAgentId ? `Parent subagent: ${record.parentAgentId}` : "",
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

async function buildCompletionResult(snapshots: CompletionSnapshot[], artifactPrefix: string, heading?: string) {
	const fullText = formatCompletionBatch(snapshots, heading);
	const truncated = truncateHead(fullText);
	let text = truncated.content;
	let outputFile: string | undefined;
	if (truncated.truncated) {
		outputFile = path.join(tmpdir(), `${artifactPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
		try {
			await writeFile(outputFile, fullText, "utf8");
			text += `\n\n[Combined subagent output truncated. Full output saved to: ${outputFile}]`;
		} catch (error) {
			outputFile = undefined;
			text += `\n\n[Combined subagent output truncated. Complete answers remain in child sessions. Could not write combined artifact: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}
	const failures = snapshots.filter((snapshot) => snapshot.outcome !== "completed").length;
	const totalCost = snapshots.reduce((sum, snapshot) => sum + snapshot.usage.cost, 0);
	const totalTokens = snapshots.reduce((sum, snapshot) => sum + totalUsageTokens(snapshot.usage), 0);
	const displaySnapshots = snapshots.map((snapshot) => ({ ...snapshot, finalAnswer: undefined }));
	return result(text, { completionSnapshots: displaySnapshots, failures, totalCost, totalTokens, outputFile, truncated: truncated.truncated });
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
	parentAgentId?: string;
	profile?: string;
	state: string;
	outcome: string;
	model: string;
	thinking: string;
	activity: string;
	cost: number;
	turns: number;
	tokens: number;
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
		parentAgentId: typeof value.parentAgentId === "string" ? value.parentAgentId : undefined,
		profile: typeof value.profile === "string" ? value.profile : undefined,
		state: typeof value.state === "string" ? value.state : typeof value.outcome === "string" ? "cold" : "accepted",
		outcome: typeof value.lastOutcome === "string" ? value.lastOutcome : typeof value.outcome === "string" ? value.outcome : "none",
		model: typeof value.model === "string" ? value.model : typeof value.modelRef === "string" ? value.modelRef : "",
		thinking: typeof value.thinking === "string" ? value.thinking : "",
		activity: typeof value.activity === "string" ? value.activity : "",
		cost: typeof value.cost === "number" ? value.cost : 0,
		turns: typeof value.turns === "number" ? value.turns : isRecord(value.usage) && typeof value.usage.turns === "number" ? value.usage.turns : 0,
		tokens: typeof value.tokens === "number" ? value.tokens : isRecord(value.usage) ? ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (typeof value.usage[key] === "number" ? value.usage[key] as number : 0), 0) : 0,
	};
}

function displayAgents(details: any): DisplayAgent[] {
	const source = Array.isArray(details?.completionSnapshots) ? details.completionSnapshots : Array.isArray(details?.displayAgents) ? details.displayAgents : Array.isArray(details?.agents) ? details.agents : details?.agent ? [details.agent] : [];
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

function isActive(record: AgentRecord): boolean {
	return record.state !== "cold";
}

function contextMeter(record: AgentRecord, theme: Theme): string {
	if (!record.contextWindow || record.contextWindow <= 0) return "";
	if (record.contextTokens === undefined) return theme.fg("muted", `?/${formatTokens(record.contextWindow)}`);
	const percent = Math.max(0, (record.contextTokens / record.contextWindow) * 100);
	const display = `${percent.toFixed(1)}%/${formatTokens(record.contextWindow)}`;
	if (percent > 90) return theme.fg("error", display);
	if (percent > 70) return theme.fg("warning", display);
	return theme.fg("muted", display);
}

function widgetLines(records: AgentRecord[], theme: Theme, now = Date.now()): string[] {
	const active = records.filter(isActive);
	const inactive = records.filter((record) => !isActive(record));
	const completed = inactive.filter((record) => record.lastOutcome === "completed").length;
	const failed = inactive.filter((record) => record.lastOutcome === "failed").length;
	const stopped = inactive.filter((record) => record.lastOutcome === "stopped" || record.lastOutcome === "interrupted").length;
	const inactiveParts = [completed ? `${completed} completed` : "", failed ? `${failed} failed` : "", stopped ? `${stopped} stopped` : ""].filter(Boolean).join(" · ");
	if (active.length === 0) {
		const known = records.length === 0 ? "none known" : `${records.length} total${inactiveParts ? ` · ${inactiveParts}` : ""}`;
		return [theme.fg("muted", `${theme.bold("Subagents")} · ${known}`)];
	}
	const header = theme.fg("toolTitle", theme.bold("Subagents"))
		+ theme.fg("muted", ` · ${active.length} active · ${inactive.length} inactive${inactiveParts ? ` (${inactiveParts})` : ""}`);
	const tree = buildVisibleTree(records.map((record) => ({ ...record, parentId: record.parentAgentId, active: isActive(record) })), MAX_WIDGET_NODES);
	const rows = tree.rows.map(({ item: record, prefix, isLast }) => {
		const state = record.state === "cold" ? record.lastOutcome : record.state;
		const connector = `${prefix}${isLast ? "└─" : "├─"} `;
		const elapsedFrom = record.activeTools.size > 0
			? Math.min(...[...record.activeTools.values()].map((tool) => tool.startedAt))
			: record.startedAt;
		const elapsed = elapsedFrom ? ` · ${formatDuration(now - elapsedFrom)}` : "";
		const activity = oneLine(currentActivity(record), 70);
		const context = contextMeter(record, theme);
		const contextText = context ? ` · ${context}` : "";
		return `${theme.fg("dim", connector)}${styledState(state, theme)}  ${theme.fg("accent", record.id)}  ${theme.fg("muted", record.title)} · ${theme.fg("dim", `${record.modelRef} [${record.thinking}]`)}${contextText} · ${theme.fg("muted", activity)}${elapsed}${record.usage.cost ? ` · ${formatCost(record.usage.cost)}` : ""}`;
	});
	if (tree.omitted > 0) rows.push(theme.fg("dim", `… ${tree.omitted} more active/ancestor node${tree.omitted === 1 ? "" : "s"}`));
	return [header, ...rows];
}

function widgetComponent(records: AgentRecord[], theme: Theme) {
	return {
		render(width: number): string[] {
			return widgetLines(records, theme).map((line) => truncateToWidth(` ${line}`, width));
		},
		invalidate() {},
	};
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
		const model = agent.model ? ` · ${theme.fg("dim", `${agent.model}${agent.thinking ? ` [${agent.thinking}]` : ""}`)}` : "";
		const profile = expanded && agent.profile ? ` · ${theme.fg("dim", `profile ${agent.profile}`)}` : "";
		return `${styledState(state, theme)}  ${theme.fg("accent", agent.id)}  ${theme.fg("muted", oneLine(agent.title, 70))}${model}${profile}${activity}${cost}`;
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

function completionSummaryResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown) {
	if (options.isError) return textOrMarkdownResult(resultValue, options, theme, lastComponent);
	if (options.isPartial) return agentSummaryResult(resultValue, options, theme, lastComponent, "Waiting");
	if (options.expanded) return new Markdown(resultText(resultValue), 0, 0, getMarkdownTheme());
	const agents = displayAgents(resultValue?.details);
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	if (agents.length === 0) {
		component.setText(theme.fg("muted", oneLine(resultText(resultValue), 500)));
		return component;
	}
	const anyMode = resultValue?.details?.waitMode === "any";
	const pendingCount = Array.isArray(resultValue?.details?.pendingAgents) ? resultValue.details.pendingAgents.length : 0;
	const failures = Number(resultValue?.details?.failures ?? agents.filter((agent) => displayState(agent) !== "completed").length);
	const totalCost = Number(resultValue?.details?.totalCost ?? agents.reduce((sum, agent) => sum + agent.cost, 0));
	const totalTokens = Number(resultValue?.details?.totalTokens ?? agents.reduce((sum, agent) => sum + agent.tokens, 0));
	const resultLabel = anyMode ? "First available" : "Batch complete";
	const countLabel = anyMode ? `${agents.length} settled` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
	const headline = failures > 0
		? theme.fg("warning", `◆ ${resultLabel} · ${countLabel} · ${failures} exceptional`)
		: theme.fg("success", `✓ ${resultLabel} · ${countLabel}`);
	const metrics = `${totalTokens > 0 ? ` · ${totalTokens.toLocaleString("en-US")} tokens` : ""}${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}`;
	const pending = pendingCount > 0 ? `\n${theme.fg("dim", `${pendingCount} still running`)}` : "";
	component.setText(`${headline}${metrics}\n${agentRows(agents, theme, false, 12, false)}${agents.length > 12 ? `\n${theme.fg("dim", `… ${agents.length - 12} more`)}` : ""}${pending}\n${theme.fg("dim", keyHint("app.tools.expand", anyMode ? "first result details" : "full batch results"))}`);
	return component;
}

function completionMessageResult(resultValue: any, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
	box.addChild(completionSummaryResult(resultValue, { expanded, isPartial: false }, theme));
	return box;
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

function buildMainInstructions(profiles: Map<string, SubagentProfile>): string {
	const profileText = [...profiles.values()].map((profile) => [
		`- ${profile.name}: ${profile.description}`,
		...profile.coordinatorGuidelines.map((guideline) => `  - ${guideline}`),
	].join("\n")).join("\n");
	return `Managed subagents:
- Do not launch subagents unless the user explicitly asks for delegated/subagent work or has already established that subagents should be used for the current task.
- Use ${START_TOOL_NAME} for ordinary delegated work. ${START_TOOL_NAME} returns immediately; continue useful work instead of polling.
- Every new subagent requires an exact provider/model-id and an explicit thinking level. Never inherit or guess either value from the main session.
- Before launching, the user must have established a clear contract for which exact model and thinking level to use for that task or class of tasks. If no such contract exists, ask the user before launching. Use \`pi --list-models <query>\` to search exact IDs as needed.
- A subagent's model and thinking level remain fixed for its lifetime. Create a new subagent to change either.
- Reuse an existing subagent with ${SEND_TOOL_NAME} only for a direct continuation or follow-up where its previous context is useful. Create a new subagent for unrelated work, independent verification, or a fresh opinion.
- Use ${STATUS_TOOL_NAME} only when current progress matters. Do not repeatedly poll. Status is compact and does not include transcripts or raw tool output.
- Launch every member of a logical batch before waiting. Then call ${WAIT_TOOL_NAME} once with the complete ID set and required wait_mode. Use wait_mode "all" for the complete batch; use wait_mode "any" when the first settled result is sufficient. An "any" wait returns the settled subset and leaves the remaining agents running.
- Cancelling or timing out ${WAIT_TOOL_NAME} leaves unfinished subagents running.
- Use ${RESULT_TOOL_NAME} for unattended, historical, or specific completed runs when their answer is needed outside the original batch wait.
- ${STOP_TOOL_NAME} stops current work but preserves the child Pi session for later continuation.
- Multiple ${START_TOOL_NAME} calls in one assistant turn may run in parallel. For large programmatic launches, ${START_TOOL_NAME} accepts input_file by itself containing a JSON array of complete normal start requests.

Available profiles${profileText ? ":" : ": none"}
${profileText}`;
}

export default async function subagentsExtension(pi: ExtensionAPI) {
	const profiles = await loadSubagentProfiles(path.join(path.dirname(fileURLToPath(import.meta.url)), "profiles"));
	pi.on("before_provider_request", (event) => {
		const promptCacheKey = process.env[PROMPT_CACHE_ENV];
		if (!promptCacheKey || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		if (Object.hasOwn(payload, "prompt_cache_key")) return { ...payload, prompt_cache_key: promptCacheKey };
		if (Object.hasOwn(payload, "promptCacheKey")) return { ...payload, promptCacheKey };
	});

	// Temporary gate: the data model and UI support parentAgentId, but managed children remain workers only.
	if (process.env[MANAGED_CHILD_ENV] === "1" && !NESTED_SUBAGENTS_ENABLED) return;

	let manager: SubagentManager | undefined;
	let latestCtx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let completionFlushScheduled = false;
	let completionFlushRunning = false;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let shuttingDown = false;

	const refreshWidget = () => {
		if (!latestCtx || latestCtx.mode !== "tui" || shuttingDown) return;
		const records = manager?.list() ?? [];
		if (records.length === 0) {
			latestCtx.ui.setWidget(WIDGET_ID, undefined);
			if (widgetTimer) {
				clearInterval(widgetTimer);
				widgetTimer = undefined;
			}
			return;
		}
		latestCtx.ui.setWidget(WIDGET_ID, (_tui, theme) => widgetComponent(records, theme));
		const hasActive = records.some(isActive);
		if (hasActive && !widgetTimer) widgetTimer = setInterval(refreshWidget, 1_000);
		else if (!hasActive && widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
	};

	const flushCompletions = async () => {
		if (completionFlushRunning || shuttingDown || !latestCtx?.isIdle() || !manager) return;
		const deliverable = manager.getDeliverable();
		if (deliverable.length === 0) return;
		completionFlushRunning = true;
		const ids = deliverable.map((record) => record.id);
		let flushed = false;
		try {
			const completion = await buildCompletionResult(deliverable.map((record) => record.latestCompletion ?? completionSnapshot(record)), "pi-subagent-completions");
			pi.sendMessage({
				customType: "subagent-completions",
				content: resultText(completion),
				display: true,
				details: completion.details,
			}, { deliverAs: "followUp", triggerTurn: true });
			manager.markDelivered(ids);
			flushed = true;
		} catch (error) {
			if (latestCtx?.hasUI) latestCtx.ui.notify(`Could not deliver subagent completion: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			completionFlushRunning = false;
			if (flushed && manager?.getDeliverable().length) scheduleCompletionFlush();
		}
	};

	const scheduleCompletionFlush = () => {
		if (completionFlushScheduled || !latestCtx?.isIdle()) return;
		completionFlushScheduled = true;
		queueMicrotask(() => {
			completionFlushScheduled = false;
			void flushCompletions();
		});
	};

	const ensureManager = (ctx: ExtensionContext): SubagentManager => {
		latestCtx = ctx;
		if (shuttingDown) throw new Error("Subagent extension is shutting down");
		if (manager) return manager;
		manager = new SubagentManager(ctx.cwd);
		manager.restore(scanSerializedAgents(ctx).map((item) => item.contextWindow
			? item
			: { ...item, contextWindow: modelContextWindow(ctx, item.modelRef) }));
		unsubscribe = manager.subscribe((event) => {
			refreshWidget();
			if (event.kind === "settled") scheduleCompletionFlush();
		});
		refreshWidget();
		return manager;
	};

	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${buildMainInstructions(profiles)}` }));

	pi.registerTool({
		name: START_TOOL_NAME,
		label: "Start Subagent",
		description: `Start one managed same-cwd Pi subagent and return immediately. Exact provider/model-id and thinking are required. Optional profile loads external instructions (${[...profiles.keys()].join(", ") || "none available"}). Alternatively supply input_file by itself containing a non-empty JSON array of complete normal start requests.`,
		parameters: Type.Object({
			input_file: Type.Optional(Type.String({ description: "Alternative to inline fields. JSON file containing an array of complete subagent_start requests. Must be supplied by itself." })),
			title: Type.Optional(Type.String({ description: "Short human-readable subagent title. Required inline." })),
			task: Type.Optional(Type.String({ description: "Complete task for this subagent. Required inline." })),
			model: Type.Optional(Type.String({ description: "Required exact provider/model-id. Never inherited or loosely matched." })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Required explicit Pi thinking level." })),
			profile: Type.Optional(Type.String({ description: `Optional instruction profile loaded from Markdown. Available: ${[...profiles.keys()].join(", ") || "none"}.` })),
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
					exactProfile(profiles, spec.profile);
					await readSystemPrompt(spec, ctx.cwd);
				}
				for (const spec of resolved.specs) {
					if (signal?.aborted) throw new Error("Subagent start aborted during preparation");
					const profile = exactProfile(profiles, spec.profile);
					if (profile) spec.profile = profile.name;
					prepared.push(await prepareAgent(spec, ctx, (task, sandbox, transcript) => genericPrompt(task, sandbox, transcript, profile), profile?.idPrefix ?? "sa"));
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
					text = `Started ${records.length} subagent${records.length === 1 ? "" : "s"}:\n\n${records.map((record) => `${record.id} · ${record.title}\n  ${record.modelRef} [${record.thinking}]${record.profile ? ` · profile ${record.profile}` : ""}\n  ${record.state} · session: ${record.sessionFile}`).join("\n\n")}`;
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
				: `${oneLine(input?.title ?? "subagent", 60)}${input?.model ? ` · ${input.model}${input.thinking ? ` [${input.thinking}]` : ""}` : ""}${input?.profile ? ` · ${input.profile}` : ""}`;
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
				const records = [...new Set<string>(params.ids)].map((id) => ensureManager(ctx).get(id));
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
		description: "Wait for selected subagents using required wait_mode: \"all\" waits for every selected agent and returns their integrated results; \"any\" returns when at least one selected agent settles and leaves the rest running. Cancellation or timeout leaves unfinished subagents running.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			input_file: Type.Optional(Type.String()),
			wait_mode: StringEnum(["all", "any"] as const, { description: "Required: all waits for every selected agent; any returns after at least one selected agent settles." }),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const ids = await resolveIds(params, ctx.cwd);
				if (params.wait_mode !== "all" && params.wait_mode !== "any") throw new Error("wait_mode is required and must be \"all\" or \"any\"");
				const waitMode = params.wait_mode as WaitMode;
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
					const waited = await activeManager.wait(ids, waitController.signal, true, waitMode);
					const snapshots = waited.settled.map((record) => record.latestCompletion ?? completionSnapshot(record));
					const completion = await buildCompletionResult(
						snapshots,
						waitMode === "any" ? "pi-subagent-any" : "pi-subagent-batch",
						waitMode === "any" ? "# First Available Subagent Results" : undefined,
					);
					const pendingText = waited.pending.length > 0
						? `\n\nStill running (${waited.pending.length}):\n${formatList(waited.pending)}`
						: "";
					return result(`${resultText(completion)}${pendingText}`, {
						...completion.details,
						waitMode,
						pendingAgents: waited.pending.map(compactRecord),
					});
				} catch (error) {
					if (!timedOut) throw error;
					const records = ids.map((id) => activeManager.get(id));
					const pending = records.filter((record) => record.state !== "cold");
					return result(`Wait timed out; unfinished subagents are still running:\n${formatList(pending.length > 0 ? pending : records)}`, {
						agents: records.map(compactRecord),
						pendingAgents: pending.map(compactRecord),
						timedOut: true,
						waitMode,
					});
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
			const selected = count !== undefined ? "" : input?.input_file ? `manifest ${path.basename(input.input_file)}` : "";
			const waitMode = input?.wait_mode === "any" || input?.wait_mode === "all" ? input.wait_mode : "";
			const timeout = input?.timeout_seconds ? `· timeout ${formatDuration(input.timeout_seconds * 1_000)}` : "";
			return toolHeader("Wait for subagents", [selected, waitMode ? `· ${waitMode}` : "", timeout].filter(Boolean).join(" "), theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			if (resultValue?.details?.timedOut) {
				const agents = displayAgents(resultValue?.details);
				const rendered = agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, "Wait timed out");
				rendered.setText(`${theme.fg("warning", `◷ Wait timed out · ${agentCounts(agents)}`)}\n${agentRows(agents, theme, options.expanded)}`);
				return rendered;
			}
			return completionSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent);
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

	pi.registerMessageRenderer("subagent-completions", (message, options, theme) => {
		return completionMessageResult({ content: [{ type: "text", text: String(message.content) }], details: message.details }, options.expanded, theme);
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
		await flushCompletions();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		if (latestCtx?.mode === "tui") latestCtx.ui.setWidget(WIDGET_ID, undefined);
		unsubscribe?.();
		unsubscribe = undefined;
		const active = manager;
		manager = undefined;
		if (active) await active.dispose();
	});
}
