import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getMarkdownTheme,
	getAgentDir,
	keyHint,
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CONFIG_DIR_NAME,
	SessionManager,
	sessionEntryToContextMessages,
	ToolExecutionComponent,
	UserMessageComponent,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import { Box, Container, Markdown, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildConversationTranscript } from "../_shared/conversation-transcript.ts";
import { cacheHitRate, formatCacheHitRate, formatCompletionBatch, type CompletionSnapshot } from "./completion.ts";
import {
	buildMainInstructions,
	combinedSystemPrompt,
	CONTEXT_MODES,
	genericPrompt,
	MAX_SHARED_PROMPT_BYTES,
	normalizeLegacyStartValue,
	parseStartRequest,
	resolveSubagentCwd,
	THINKING_LEVELS,
	type BatchSpec,
	type StartSpec,
} from "./launch-contract.ts";
import { loadSubagentRoles, type SubagentRole } from "./roles.ts";
import { applyRuntimeStatusEvent } from "./runtime-events.ts";
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	shouldCancelManagedSubagentCompaction,
	shouldCompactBeforeContinuation,
	shouldContinueManagedSubagentAfterCompaction,
	type ManagedSubagentCompactionPolicy,
} from "./compaction-policy.ts";
import { materializeSessionFile } from "./session-file.ts";
import { renderIndentedAlignedTable, type AlignedColumn } from "../_shared/aligned-table.ts";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "../_shared/spinner.ts";
import { buildVisibleTree } from "./tree.ts";
import { MAX_LISTED_SUBAGENTS, takeRecent } from "./list-policy.ts";
import { implicitAnyWaitCandidates, incrementalWaitState } from "./wait-policy.ts";
import {
	publishHierarchySnapshot as writeHierarchySnapshot,
	readHierarchyRegistry,
	removeHierarchyReporter,
	type HierarchySnapshot,
} from "./hierarchy-registry.ts";
import { isUnusedRpcStreamEvent } from "./rpc-event-filter.ts";
import {
	PARENT_REPORT_DELIVERIES,
	parentReportNotification,
	parseParentReportEvent,
	takeParentReportBatch,
	type ParentReportDeliveryOpportunity,
	type ParentReportDelivery,
} from "./parent-report.ts";

const LEGACY_REVIEW_TOOL_NAME = "launch_review_subagents";
const START_TOOL_NAME = "subagent_start";
const LIST_TOOL_NAME = "subagent_list";
const STATUS_TOOL_NAME = "subagent_status";
const SEND_TOOL_NAME = "subagent_send";
const REPORT_TOOL_NAME = "subagent_report";
const WAIT_TOOL_NAME = "subagent_wait";
const RESULT_TOOL_NAME = "subagent_result";
const STOP_TOOL_NAME = "subagent_stop";

const MANAGED_CHILD_ENV = "PI_MANAGED_SUBAGENT";
const HIERARCHY_REGISTRY_ENV = "PI_SUBAGENT_HIERARCHY_REGISTRY";
const CURRENT_AGENT_ENV = "PI_SUBAGENT_CURRENT_AGENT_ID";
const PROMPT_CACHE_ENV = "PI_SUBAGENT_PROMPT_CACHE_KEY";
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const NORMAL_LAUNCH_DETAIL_LIMIT = 10;
const MAX_RECENT_ACTIVITIES = 5;
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 1_000;
const MAX_RPC_STDERR_CHARS = 128 * 1024;
const RECENT_FINISHED_WIDGET_MS = 60_000;
const MANUAL_COMPACTION_TIMEOUT_MS = 10 * 60_000;

const WIDGET_ID = "subagents-tree";
const WIDGET_STATE_REFRESH_MS = 100;
const WIDGET_CLOCK_REFRESH_MS = 1_000;
const HIERARCHY_REFRESH_MS = 1_000;
const HIERARCHY_STALE_MS = 5_000;

type SubagentDisplayRow = {
	indent: string;
	connector: string;
	state: string;
	id: string;
	role: string;
	title: string;
	model: string;
	context: string;
	duration: string;
	cost: string;
	cache: string;
	activity: string;
};

// Keep the durable widget and tool-result previews as a compact table. The
// preferred widths come from the current rows; these bounds only stop a long
// title/path/activity from stealing the whole terminal. Flexible columns are
// shrunk first, then low-priority metrics disappear on narrow terminals.
const SUBAGENT_COLUMNS: readonly AlignedColumn<keyof SubagentDisplayRow>[] = [
	{ key: "state", minWidth: 7 },
	{ key: "id", minWidth: 8 },
	{ key: "role", maxWidth: 22, shrinkPriority: 1, optional: true, hidePriority: 1 },
	{ key: "title", minWidth: 12, maxWidth: 46, shrinkPriority: 2 },
	{ key: "model", minWidth: 12, maxWidth: 42, shrinkPriority: 1 },
	{ key: "context", minWidth: 8, maxWidth: 12, align: "right", optional: true, hidePriority: 2 },
	{ key: "duration", minWidth: 5, maxWidth: 10, align: "right", optional: true, hidePriority: 3 },
	{ key: "cost", minWidth: 6, maxWidth: 9, align: "right", optional: true, hidePriority: 4 },
	{ key: "cache", minWidth: 6, maxWidth: 9, align: "right", optional: true, hidePriority: 5 },
	{ key: "activity", minWidth: 12, maxWidth: 70, shrinkPriority: 4 },
];

function renderSubagentTable(rows: SubagentDisplayRow[], width: number): string[] {
	return renderIndentedAlignedTable(rows, width, SUBAGENT_COLUMNS, {
		gap: "  ",
		visibleWidth,
		truncate: (value, cellWidth) => truncateToWidth(value, cellWidth),
	}, (row) => `${row.indent}${row.connector}`);
}

function widgetSpinnerFrame(now: number): string {
	const clockTick = Math.floor(now / WIDGET_CLOCK_REFRESH_MS);
	return spinnerFrame(clockTick * SPINNER_INTERVAL_MS);
}

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
	latestCacheHitRate?: number;
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

type StartToolParams = Partial<StartSpec> & {
	batch?: BatchSpec;
	input_file?: string;
};

type ResolvedStartRequest = {
	specs: StartSpec[];
	batch?: BatchSpec;
	manifest?: LaunchManifestMetadata;
};

type SerializedBatch = {
	id: string;
	title: string;
	sharedPrompt: string;
	role?: string;
	parentAgentId?: string;
	memberIds: string[];
	createdAt: number;
};

type BatchRecord = SerializedBatch;

type SerializedAgent = {
	id: string;
	title: string;
	task: string;
	modelRef: string;
	thinking: ThinkingLevel;
	role?: string;
	batchId?: string;
	parentAgentId?: string;
	contextMode: ContextMode;
	contextFiles: boolean;
	cwd?: string;
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
	lastAssistantStopReason?: string;
	settling: boolean;
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

type HierarchyAgentSnapshot = SerializedAgent & {
	state: AgentRuntimeState;
	lastOutcome: RunOutcome;
	currentRunId?: string;
	startedAt?: number;
	updatedAt: number;
	settledAt?: number;
	lastObservedAt?: number;
	recent: Activity[];
	usage: UsageStats;
	contextTokens?: number;
};

type SubagentHierarchySnapshot = HierarchySnapshot<HierarchyAgentSnapshot, SerializedBatch>;

type PreparedAgent = {
	record: AgentRecord;
	prompt: string;
};

type ManagerEvent =
	| { kind: "changed"; id: string }
	| { kind: "settled"; id: string }
	| { kind: "parent_message"; id: string; message: string; delivery: ParentReportDelivery; interruptedWait: boolean };

type ParentMessage = {
	id: string;
	message: string;
	delivery: ParentReportDelivery;
};

type PendingParentMessage = ParentMessage & {
	title: string;
};

type ActiveWait = {
	ids: Set<string>;
	report?: ParentMessage;
	resolveReport: (report: ParentMessage) => void;
};

type WaitResult = {
	mode: WaitMode;
	selected: AgentRecord[];
	settled: AgentRecord[];
	pending: AgentRecord[];
	report?: ParentMessage;
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

async function loadManagedSubagentCompactionPolicy(cwd: string): Promise<ManagedSubagentCompactionPolicy> {
	const policy: ManagedSubagentCompactionPolicy = {
		enabled: true,
		reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
	};
	const settingsPaths = [
		path.join(getAgentDir(), "settings.json"),
		path.join(cwd, CONFIG_DIR_NAME, "settings.json"),
	];
	for (const settingsPath of settingsPaths) {
		try {
			const settings = JSON.parse(await readFile(settingsPath, "utf8"));
			if (!isRecord(settings) || !isRecord(settings.compaction)) continue;
			if (typeof settings.compaction.enabled === "boolean") policy.enabled = settings.compaction.enabled;
			const reserveTokens = settings.compaction.reserveTokens;
			if (typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens >= 0) policy.reserveTokens = reserveTokens;
		} catch {
			// Missing or invalid settings are handled by Pi itself; mirror its defaults here.
		}
	}
	return policy;
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
	record.usage.latestCacheHitRate = cacheHitRate({ input, cacheRead, cacheWrite });
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

function settledDuration(record: AgentRecord): number | undefined {
	if (record.startedAt === undefined || record.settledAt === undefined) return undefined;
	return Math.max(0, record.settledAt - record.startedAt);
}

function serializeAgent(record: AgentRecord): SerializedAgent {
	return {
		id: record.id,
		title: record.title,
		task: record.task,
		modelRef: record.modelRef,
		thinking: record.thinking,
		role: record.role,
		batchId: record.batchId,
		parentAgentId: record.parentAgentId,
		contextMode: record.contextMode,
		contextFiles: record.contextFiles,
		cwd: record.cwd,
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
		role: record.role,
		batchId: record.batchId,
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
		settling: false,
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
	const task = value.match(/<(?:individual_task|task)>\s*([\s\S]*?)\s*<\/(?:individual_task|task)>/)?.[1];
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
		record.cwd ??= manager.getCwd();
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
			record.lastAssistantStopReason = lastAssistant.stopReason;
			if (lastAssistant.stopReason === "stop") {
				record.lastOutcome = "completed";
				record.error = undefined;
				record.finalAnswer = assistantText(lastAssistant);
			} else if (lastAssistant.stopReason === "length") {
				record.lastOutcome = "failed";
				record.error = "Assistant response was cut short (provider stop reason: length)";
			} else if (lastAssistant.stopReason === "aborted") {
				record.lastOutcome = "interrupted";
				record.error = lastAssistant.errorMessage || "Assistant run aborted";
			} else if (lastAssistant.stopReason === "error" || lastAssistant.errorMessage) {
				record.lastOutcome = "failed";
				record.error = lastAssistant.errorMessage || "assistant error";
			} else if (lastAssistant.stopReason !== "stop") {
				record.lastOutcome = "interrupted";
				record.error = undefined;
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
		private readonly parentCwd: string,
		private readonly onEvent: (event: any) => void,
		private readonly hierarchyRegistryDir?: string,
	) {}

	start(): void {
		const args = [
			"--mode", "rpc",
			"--session", this.record.sessionFile,
			"--model", this.record.modelRef,
			"--thinking", this.record.thinking,
			"--name", `[Subagent ${this.record.id}] ${this.record.title}`,
		];
		if (!this.record.contextFiles) args.push("--no-context-files");
		if (this.record.systemPromptPath) args.push("--append-system-prompt", this.record.systemPromptPath);
		const invocation = getPiInvocation(args);
		this.child = spawn(invocation.command, invocation.args, {
			cwd: this.record.cwd ?? this.parentCwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					[MANAGED_CHILD_ENV]: "1",
					...(this.hierarchyRegistryDir ? { [HIERARCHY_REGISTRY_ENV]: this.hierarchyRegistryDir } : {}),
					[CURRENT_AGENT_ENV]: this.record.id,
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

	async send(type: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
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
		if (isUnusedRpcStreamEvent(line)) {
			const now = Date.now();
			this.record.updatedAt = now;
			this.record.lastObservedAt = now;
			return;
		}
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
	private readonly batches = new Map<string, BatchRecord>();
	private readonly queue: AgentRecord[] = [];
	private readonly listeners = new Set<(event: ManagerEvent) => void>();
	private readonly activeWaits = new Set<ActiveWait>();
	private disposed = false;

	constructor(
		private readonly cwd: string,
		private readonly compactionPolicy: ManagedSubagentCompactionPolicy,
		private readonly hierarchyRegistryDir?: string,
	) {}

	restore(items: SerializedAgent[], batches: SerializedBatch[] = []): void {
		for (const batch of batches) {
			if (!this.batches.has(batch.id)) this.batches.set(batch.id, { ...batch, memberIds: [...batch.memberIds] });
		}
		for (const item of items) {
			if (this.records.has(item.id)) continue;
			const record = newRecord(item);
			inspectPersistedRecord(record);
			this.records.set(record.id, record);
		}
	}

	addMany(preparedItems: PreparedAgent[], batch?: BatchRecord): AgentRecord[] {
		this.assertActive();
		const ids = preparedItems.map((item) => item.record.id);
		if (new Set(ids).size !== ids.length) throw new Error("Duplicate subagent IDs in prepared launch");
		for (const id of ids) if (this.records.has(id) || this.batches.has(id)) throw new Error(`Duplicate subagent ID: ${id}`);
		if (batch && (this.batches.has(batch.id) || this.records.has(batch.id) || ids.includes(batch.id))) throw new Error(`Duplicate subagent batch ID: ${batch.id}`);
		if (batch && (batch.memberIds.length !== ids.length || batch.memberIds.some((id, index) => id !== ids[index]))) throw new Error(`Batch ${batch.id} members do not match the prepared launch`);
		if (batch) this.batches.set(batch.id, batch);
		const records = preparedItems.map((prepared) => {
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
			return record;
		});
		for (const record of records) this.emit({ kind: "changed", id: record.id });
		this.pump();
		return records;
	}

	list(): AgentRecord[] {
		return [...this.records.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	listBatches(): BatchRecord[] {
		return [...this.batches.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	getBatch(id: string): BatchRecord {
		const batch = this.batches.get(id);
		if (!batch) throw new Error(`Unknown subagent batch ID: ${id}`);
		return batch;
	}

	batchMembers(id: string): AgentRecord[] {
		return this.getBatch(id).memberIds.map((memberId) => this.get(memberId));
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
		record.lastAssistantStopReason = undefined;
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
		let deliveryHandled = false;
		let abortHandler: (() => void) | undefined;
		let resolveReport!: (report: ParentMessage) => void;
		const reportPromise = new Promise<ParentMessage>((resolve) => { resolveReport = resolve; });
		const activeWait: ActiveWait = { ids: new Set(records.map((record) => record.id)), resolveReport };
		this.activeWaits.add(activeWait);
		const abortPromise = signal ? new Promise<never>((_resolve, reject) => {
			abortHandler = () => reject(new SubagentWaitAbortedError());
			signal.addEventListener("abort", abortHandler, { once: true });
		}) : new Promise<never>(() => {});
		try {
			if (signal?.aborted) throw new SubagentWaitAbortedError();
			let settled: AgentRecord[];
			let pending: AgentRecord[];
			if (mode === "any") {
				while (true) {
					({ settled, pending } = incrementalWaitState(records));
					if (activeWait.report || settled.length > 0 || pending.length === 0) break;
					await Promise.race([
						Promise.race(pending.map((record) => record.completion ?? Promise.resolve())),
						reportPromise,
						abortPromise,
					]);
				}
			} else {
				await Promise.race([
					Promise.all(records.map((record) => record.completion ?? Promise.resolve())),
					reportPromise,
					abortPromise,
				]);
				settled = records;
				pending = [];
			}
			if (activeWait.report) {
				return {
					mode,
					selected: records,
					settled: [],
					pending: records.filter((record) => record.state !== "cold"),
					report: activeWait.report,
				};
			}
			if (consumeDelivery) {
				for (const record of settled) {
					record.deliveryConsumed = true;
					record.deliveryPending = false;
				}
				deliveryHandled = true;
			}
			return { mode, selected: records, settled, pending };
		} finally {
			this.activeWaits.delete(activeWait);
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			for (const record of records) {
				record.waiters = Math.max(0, record.waiters - 1);
				if (!deliveryHandled && record.waiters === 0 && record.state === "cold" && !record.deliveryConsumed) {
					record.deliveryPending = true;
					this.emit({ kind: "settled", id: record.id });
				}
			}
		}
	}

	async stop(ids: string[]): Promise<AgentRecord[]> {
		const records = [...new Set(ids)].map((id) => this.get(id));
		await Promise.all(records.map(async (record) => {
			// A batch stop may include members that already finished. Their final
			// answers still need normal automatic delivery unless a wait consumed
			// them, so only consume delivery for work that is actually being stopped.
			if (record.state === "cold") return;
			if (record.settling) {
				await record.completion;
				return;
			}
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

	markDelivered(runs: Array<{ id: string; runId?: string }>): void {
		for (const run of runs) {
			const record = this.records.get(run.id);
			if (!record) continue;
			if (run.runId !== undefined && record.currentRunId !== run.runId) continue;
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
			while (!this.disposed && this.queue.length > 0) {
				const record = this.queue.shift()!;
				if (record.stopRequested || record.state !== "queued") continue;
				void this.run(record).finally(() => {
					this.pump();
				});
			}
		});
	}

	private async run(record: AgentRecord): Promise<void> {
		let terminalError: string | undefined;
		for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
			record.attempt = attempt;
			record.settling = false;
			record.state = "starting";
			record.startedAt ??= Date.now();
			addActivity(record, attempt === 1 ? "starting Pi RPC session" : `retrying, attempt ${attempt}/${MAX_RETRIES + 1}`);
			this.emit({ kind: "changed", id: record.id });
			let attemptUsedTool = false;
			let resolveSettled!: () => void;
			const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
			const client = new RpcClient(record, this.cwd, (event) => {
				if (event.type === "tool_execution_start") attemptUsedTool = true;
				const changed = this.applyEvent(record, event);
				if (event.type === "agent_settled") {
					record.settling = true;
					resolveSettled();
				}
				if (changed) this.emit({ kind: "changed", id: record.id });
			}, this.hierarchyRegistryDir);
			record.client = client;
			try {
				client.start();
				const exitPromise = client.waitForExit();
				if (record.runNumber > 1 && this.compactionPolicy.enabled) {
					try {
						const stats = await client.send("get_session_stats", {}, 5_000);
						const contextUsage = stats?.data?.contextUsage;
						if (shouldCompactBeforeContinuation(record.runNumber, contextUsage, this.compactionPolicy)) {
							addActivity(record, "compacting deferred context before continuation");
							this.emit({ kind: "changed", id: record.id });
							await client.send("compact", {}, MANUAL_COMPACTION_TIMEOUT_MS);
						}
					} catch (error) {
						// Do not lose a continuation because proactive compaction failed. The
						// normal overflow recovery path remains enabled for the prompt itself.
						addActivity(record, `deferred compaction unavailable: ${oneLine(error instanceof Error ? error.message : String(error), 100)}`);
						this.emit({ kind: "changed", id: record.id });
					}
				}
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
					// agent_settled is the session-level terminal boundary. If the
					// final assistant message succeeded, any earlier provider error
					// was recovered even if that success was only visible via
					// agent_end rather than message_end.
					if (record.lastAssistantStopReason === "stop" || record.lastAssistantStopReason === "toolUse") {
						record.error = undefined;
					}
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
		} else if (record.lastAssistantStopReason === "aborted") {
			record.lastOutcome = "interrupted";
			record.error = record.error || "Assistant run aborted";
			addActivity(record, `interrupted: ${oneLine(record.error, 120)}`);
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

	/** Apply an RPC event and report whether it changed visible state. */
	private applyEvent(record: AgentRecord, event: any): boolean {
		const now = Date.now();
		record.updatedAt = now;
		record.lastObservedAt = now;
		const parentReport = parseParentReportEvent(event);
		if (parentReport) {
			addActivity(record, `reported to parent: ${oneLine(parentReport.message, 90)}`, now);
			const message = { id: record.id, ...parentReport };
			let interruptedWait = false;
			for (const activeWait of this.activeWaits) {
				if (!activeWait.ids.has(record.id) || activeWait.report) continue;
				activeWait.report = message;
				activeWait.resolveReport(message);
				interruptedWait = true;
			}
			this.emit({ kind: "parent_message", ...message, interruptedWait });
			return true;
		}
		const runtimeActivity = applyRuntimeStatusEvent(record, event);
		if (runtimeActivity) addActivity(record, runtimeActivity, now);
		if (event.type === "agent_start") {
			record.state = "running";
			addActivity(record, "agent running", now);
			return true;
		}
		if (event.type === "tool_execution_start") {
			const description = compactToolActivity(event.toolName, event.args);
			record.activeTools.set(event.toolCallId, { name: event.toolName, description, startedAt: now });
			addActivity(record, description, now);
			return true;
		}
		if (event.type === "tool_execution_end") {
			const active = record.activeTools.get(event.toolCallId);
			record.activeTools.delete(event.toolCallId);
			if (active) addActivity(record, `${active.name} ${event.isError ? "failed" : "finished"}`, now);
			return Boolean(active);
		}
		if (event.type === "message_update") {
			const type = event.assistantMessageEvent?.type;
			if (type === "thinking_start") addActivity(record, "thinking", now);
			else if (type === "text_start") addActivity(record, "writing response", now);
			return type === "thinking_start" || type === "text_start";
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			updateUsage(record, event.message);
			const text = assistantText(event.message);
			if (text) record.finalAnswer = text;
			return true;
		}
		if (event.type === "agent_end") {
			const text = finalAssistantText(event.messages || []);
			if (text) record.finalAnswer = text;
			return true;
		}
		return Boolean(runtimeActivity);
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
		metadata: {
			path: canonical,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.byteLength,
			entries: Array.isArray(value) ? value.length : isRecord(value) && isRecord(value.batch) && Array.isArray(value.batch.agents) ? value.batch.agents.length : 1,
		},
	};
}

async function resolveStartRequest(params: StartToolParams, cwd: string): Promise<ResolvedStartRequest> {
	if (!isRecord(params)) throw new Error("Tool input must be an object");
	if (Object.hasOwn(params, "input_file")) {
		if (Object.keys(params).some((key) => key !== "input_file")) throw new Error("input_file must be supplied by itself");
		if (typeof params.input_file !== "string" || !cleanText(params.input_file)) throw new Error("input_file is required and must be non-empty");
		const loaded = await readJsonFile(params.input_file, cwd);
		return { ...parseStartRequest(loaded.value, "manifest"), manifest: loaded.metadata };
	}
	return parseStartRequest(params, "tool input");
}

function exactRole(roles: Map<string, SubagentRole>, raw: string | undefined): SubagentRole | undefined {
	if (raw === undefined) return undefined;
	const name = cleanText(raw);
	const role = roles.get(name);
	if (!role) throw new Error(`Unknown subagent role ${JSON.stringify(name)}. Available: ${[...roles.keys()].join(", ") || "none"}`);
	return role;
}

function createClonedSessionBeforeLatestUser(ctx: ExtensionContext, childCwd: string): SessionManager {
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
	const source = (SessionManager.open as any)(sourceSessionFile, ctx.sessionManager.getSessionDir(), childCwd) as SessionManager;
	if (!cloneLeafId) {
		return (SessionManager.create as any)(childCwd, ctx.sessionManager.getSessionDir(), { parentSession: sourceSessionFile }) as SessionManager;
	}
	const cloned = source.createBranchedSession(cloneLeafId);
	if (!cloned) throw new Error("failed to create cloned subagent session");
	// createBranchedSession rebinds the source manager to the extracted session.
	// Keep that manager so a branch without an assistant message can still be
	// materialized with its parentSession header below.
	return source;
}

async function prepareAgent(
	spec: StartSpec,
	ctx: ExtensionContext,
	role: SubagentRole | undefined,
	sharedPrompt?: string,
	batchId?: string,
): Promise<PreparedAgent> {
	const model = exactModel(ctx, spec.model);
	validateThinking(model, spec.thinking);
	const contextMode = spec.context ?? "fresh";
	const childCwd = spec.cwd ?? ctx.cwd;
	const id = `sa-${randomUUID().slice(0, 8)}`;
	const sandboxDir = path.join(tmpdir(), "pi-subagents", id);
	let sessionFile: string | undefined;
	let systemPromptPath: string | undefined;
	try {
		await mkdir(sandboxDir, { recursive: true });
		const systemPromptBytes = await combinedSystemPrompt(spec, role, ctx.cwd);
		const parentSession = ctx.sessionManager.isPersisted() ? ctx.sessionManager.getSessionFile() : undefined;
		const childSession = contextMode === "clone"
			? createClonedSessionBeforeLatestUser(ctx, childCwd)
			: ((SessionManager.create as any)(childCwd, ctx.sessionManager.getSessionDir(), { parentSession }) as SessionManager);
		sessionFile = childSession.getSessionFile();
		if (!sessionFile) throw new Error("failed to create a persisted subagent session");
		childSession.appendSessionInfo(`[Subagent ${id}] ${sanitizeTitle(spec.title)}`);
		await materializeSessionFile(childSession);
		// Continuations may happen long after the OS has cleared temporary files.
		// Keep the effective role/custom system prompt beside the durable child
		// session rather than in its disposable scratch sandbox.
		systemPromptPath = systemPromptBytes ? `${sessionFile}.system-prompt.md` : undefined;
		if (systemPromptPath) await writeFile(systemPromptPath, systemPromptBytes!);
		const transcript = contextMode === "transcript" ? buildConversationTranscript(ctx.sessionManager.getBranch(), true).text : undefined;
		if (contextMode === "transcript" && !transcript) throw new Error("transcript context was requested, but there is no completed parent conversation before the current turn");
		const serialized: SerializedAgent = {
			id,
			title: sanitizeTitle(spec.title),
			task: cleanText(spec.task),
			modelRef: modelRef(model),
			thinking: spec.thinking,
			role: role?.name,
			batchId,
			parentAgentId: process.env[CURRENT_AGENT_ENV] || undefined,
			contextMode,
			contextFiles: spec.context_files !== false,
			cwd: childCwd,
			sessionFile,
			sandboxDir,
			systemPromptPath,
			promptCacheKey: contextMode === "clone" ? ctx.sessionManager.getSessionId() : undefined,
			createdAt: Date.now(),
			runNumber: 0,
			contextWindow: model.contextWindow,
		};
		return { record: newRecord(serialized), prompt: genericPrompt(serialized.task, sandboxDir, transcript, sharedPrompt, childCwd) };
	} catch (error) {
		await Promise.all([
			rm(sandboxDir, { recursive: true, force: true }).catch(() => {}),
			sessionFile ? unlink(sessionFile).catch(() => {}) : Promise.resolve(),
			systemPromptPath ? unlink(systemPromptPath).catch(() => {}) : Promise.resolve(),
		]);
		throw error;
	}
}

async function cleanupPreparedAgents(prepared: PreparedAgent[]): Promise<void> {
	await Promise.all(prepared.flatMap(({ record }) => [
		rm(record.sandboxDir, { recursive: true, force: true }).catch(() => {}),
		unlink(record.sessionFile).catch(() => {}),
		record.systemPromptPath ? unlink(record.systemPromptPath).catch(() => {}) : Promise.resolve(),
	]));
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
				const restored = value as unknown as SerializedAgent & { profile?: string };
				byId.set(value.id, {
					...restored,
					role: typeof restored.role === "string" ? restored.role : typeof restored.profile === "string" ? restored.profile : undefined,
					contextFiles: restored.contextFiles !== false,
				});
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

function scanSerializedBatches(ctx: ExtensionContext): SerializedBatch[] {
	const byId = new Map<string, SerializedBatch>();
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		if (entry.message.toolName !== START_TOOL_NAME) continue;
		const batches = entry.message.details?.batches;
		if (!Array.isArray(batches)) continue;
		for (const value of batches) {
			if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Array.isArray(value.memberIds)) continue;
			byId.set(value.id, {
				id: value.id,
				title: value.title,
				sharedPrompt: typeof value.sharedPrompt === "string" ? value.sharedPrompt : "",
				role: typeof value.role === "string" ? value.role : undefined,
				parentAgentId: typeof value.parentAgentId === "string" ? value.parentAgentId : undefined,
				memberIds: value.memberIds.filter((id): id is string => typeof id === "string"),
				createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
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
		role: record.role,
		batchId: record.batchId,
		parentAgentId: record.parentAgentId,
		contextFiles: record.contextFiles,
		cwd: record.cwd,
		currentRunId: record.currentRunId,
		activity: currentActivity(record),
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		settledAt: record.settledAt,
		durationMs: settledDuration(record),
		cost: record.usage.cost,
		turns: record.usage.turns,
		tokens: totalUsageTokens(record.usage),
		cacheHitRate: record.usage.latestCacheHitRate,
		hasCacheUsage: record.usage.cacheRead > 0 || record.usage.cacheWrite > 0,
		contextWindow: record.contextWindow,
		contextTokens: record.contextTokens,
		sessionFile: record.sessionFile,
	};
}

function compactBatch(batch: BatchRecord): Record<string, unknown> {
	return {
		id: batch.id,
		title: batch.title,
		sharedPrompt: batch.sharedPrompt,
		role: batch.role,
		parentAgentId: batch.parentAgentId,
		memberIds: [...batch.memberIds],
		createdAt: batch.createdAt,
	};
}

function aggregateState(records: Array<Pick<AgentRecord, "state" | "lastOutcome">>): string {
	if (records.some((record) => record.state === "running" || record.state === "starting")) return "running";
	if (records.some((record) => record.state === "queued")) return "queued";
	if (records.some((record) => record.state === "stopping")) return "stopping";
	if (records.some((record) => record.lastOutcome === "failed")) return "failed";
	if (records.some((record) => record.lastOutcome === "interrupted")) return "interrupted";
	if (records.some((record) => record.lastOutcome === "stopped")) return "stopped";
	if (records.length > 0 && records.every((record) => record.lastOutcome === "completed")) return "completed";
	return "none";
}

function batchActivity(records: Array<Pick<AgentRecord, "state" | "lastOutcome">>, total = records.length): string {
	const completed = records.filter((record) => record.state === "cold" && record.lastOutcome === "completed").length;
	const active = records.filter((record) => record.state !== "cold").length;
	const exceptional = records.filter((record) => record.state === "cold" && record.lastOutcome !== "completed" && record.lastOutcome !== "none").length;
	return `${completed}/${total} completed${active ? ` · ${active} active` : ""}${exceptional ? ` · ${exceptional} exceptional` : ""}`;
}

function formatList(records: AgentRecord[], batches: BatchRecord[] = []): string {
	if (records.length === 0) return "No subagents are known in this parent session.";
	type ListNode = { id: string; parentId?: string; createdAt: number; active: boolean; kind: "agent"; record: AgentRecord }
		| { id: string; parentId?: string; createdAt: number; active: boolean; kind: "batch"; batch: BatchRecord };
	const knownBatchIds = new Set(batches.map((batch) => batch.id));
	const nodes: ListNode[] = [
		...batches.map((batch): ListNode => ({ id: batch.id, parentId: batch.parentAgentId, createdAt: batch.createdAt, active: true, kind: "batch", batch })),
		...records.map((record): ListNode => ({ id: record.id, parentId: record.batchId && knownBatchIds.has(record.batchId) ? record.batchId : record.parentAgentId, createdAt: record.createdAt, active: true, kind: "agent", record })),
	];
	return buildVisibleTree(nodes, Math.max(nodes.length, 1)).rows.map(({ item, prefix, isLast }) => {
		const connector = `${prefix}${isLast ? "└─" : "├─"} `;
		if (item.kind === "batch") {
			const members = records.filter((record) => item.batch.memberIds.includes(record.id));
			const partial = members.length < item.batch.memberIds.length;
			const state = partial ? "partial" : aggregateState(members);
			return `${connector}${item.batch.id} · ${state}${item.batch.role ? ` · [${item.batch.role}]` : ""} · ${item.batch.title} · ${partial ? `${members.length}/${item.batch.memberIds.length} shown · ` : ""}${batchActivity(members)}`;
		}
		const record = item.record;
		const state = record.state === "cold" ? `cold; last run ${record.lastOutcome}` : record.state;
		const duration = settledDuration(record);
		const cache = formatCacheHitRate(record.usage.latestCacheHitRate, record.usage.cacheRead > 0 || record.usage.cacheWrite > 0);
		const metrics = [duration === undefined ? "" : formatDuration(duration), cache].filter(Boolean).join(" · ");
		const inheritedRole = batches.find((batch) => batch.id === record.batchId)?.role;
		return `${connector}${record.id} · ${state}${record.role && record.role !== inheritedRole ? ` · [${record.role}]` : ""} · ${record.modelRef} [${record.thinking}]${metrics ? ` · ${metrics}` : ""} · ${record.title} · ${oneLine(currentActivity(record), 100)}`;
	}).join("\n");
}

function formatStatus(record: AgentRecord): string {
	const now = Date.now();
	const lines = [
		`${record.id} — ${record.title}`,
		`State: ${record.state}${record.state === "cold" ? `; last run ${record.lastOutcome}` : ""}`,
		`Model: ${record.modelRef}`,
		`Thinking: ${record.thinking}`,
		record.role ? `Role: ${record.role}` : "",
		record.batchId ? `Batch: ${record.batchId}` : "",
		record.parentAgentId ? `Parent subagent: ${record.parentAgentId}` : "",
		`Context: ${record.contextMode}`,
		`Context files: ${record.contextFiles ? "enabled" : "disabled"}`,
		`Working directory: ${record.cwd ?? "inherited parent directory"}`,
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
	const duration = settledDuration(record);
	const cache = formatCacheHitRate(record.usage.latestCacheHitRate, record.usage.cacheRead > 0 || record.usage.cacheWrite > 0);
	lines.push(`Usage: ${formatCost(record.usage.cost)} · ${record.usage.turns} model turn${record.usage.turns === 1 ? "" : "s"}${duration === undefined ? "" : ` · ${formatDuration(duration)}`}${cache ? ` · ${cache}` : ""}${context}`);
	if (record.error) lines.push(`Error: ${oneLine(record.error, 300)}`);
	lines.push(`Session: ${record.sessionFile}`);
	return lines.filter(Boolean).join("\n");
}

async function buildCompletionResult(snapshots: CompletionSnapshot[], artifactPrefix: string, heading?: string, batches: BatchRecord[] = []) {
	const fullText = formatCompletionBatch(snapshots, heading, batches.map((batch) => ({
		id: batch.id,
		title: batch.title,
		role: batch.role,
		memberIds: batch.memberIds,
	})));
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
	return result(text, { completionSnapshots: displaySnapshots, batches: batches.map(compactBatch), failures, totalCost, totalTokens, outputFile, truncated: truncated.truncated });
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
	if (assistant.stopReason === "length") throw new Error(`Run ${selectedRun} was cut short (provider stop reason: length) before producing a complete answer`);
	if (assistant.stopReason !== "stop") {
		throw new Error(`No final assistant answer found for ${selectedRun}; the run was interrupted after a partial response`);
	}
	return { runId: selectedRun, text: assistantText(assistant) };
}

function result(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

type DisplayAgent = {
	id: string;
	title: string;
	parentAgentId?: string;
	batchId?: string;
	role?: string;
	createdAt: number;
	state: string;
	outcome: string;
	model: string;
	thinking: string;
	activity: string;
	cost: number;
	turns: number;
	tokens: number;
	cacheHitRate?: number;
	hasCacheUsage: boolean;
	durationMs?: number;
	contextWindow?: number;
	contextTokens?: number;
};

type DisplayBatch = {
	id: string;
	title: string;
	sharedPrompt?: string;
	role?: string;
	parentAgentId?: string;
	memberIds: string[];
	createdAt: number;
};

function resultText(value: any): string {
	if (!Array.isArray(value?.content)) return "";
	return value.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function displayAgent(value: unknown, fallbackCreatedAt = 0): DisplayAgent | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	return {
		id: value.id,
		title: typeof value.title === "string" ? value.title : "subagent",
		parentAgentId: typeof value.parentAgentId === "string" ? value.parentAgentId : undefined,
		batchId: typeof value.batchId === "string" ? value.batchId : undefined,
		role: typeof value.role === "string" ? value.role : typeof value.profile === "string" ? value.profile : undefined,
		createdAt: typeof value.createdAt === "number" ? value.createdAt : fallbackCreatedAt,
		state: typeof value.state === "string" ? value.state : typeof value.outcome === "string" ? "cold" : "accepted",
		outcome: typeof value.lastOutcome === "string" ? value.lastOutcome : typeof value.outcome === "string" ? value.outcome : "none",
		model: typeof value.model === "string" ? value.model : typeof value.modelRef === "string" ? value.modelRef : "",
		thinking: typeof value.thinking === "string" ? value.thinking : "",
		activity: typeof value.activity === "string" ? value.activity : "",
		cost: typeof value.cost === "number" ? value.cost : 0,
		turns: typeof value.turns === "number" ? value.turns : isRecord(value.usage) && typeof value.usage.turns === "number" ? value.usage.turns : 0,
		tokens: typeof value.tokens === "number" ? value.tokens : isRecord(value.usage) ? ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (typeof value.usage[key] === "number" ? value.usage[key] as number : 0), 0) : 0,
		cacheHitRate: typeof value.cacheHitRate === "number" ? value.cacheHitRate : isRecord(value.usage) && typeof value.usage.latestCacheHitRate === "number" ? value.usage.latestCacheHitRate : undefined,
		hasCacheUsage: typeof value.hasCacheUsage === "boolean"
			? value.hasCacheUsage
			: isRecord(value.usage) && (Number(value.usage.cacheRead) > 0 || Number(value.usage.cacheWrite) > 0),
		durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
		contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
		contextTokens: typeof value.contextTokens === "number" ? value.contextTokens : undefined,
	};
}

function displayAgents(details: any): DisplayAgent[] {
	const source = Array.isArray(details?.completionSnapshots) ? details.completionSnapshots : Array.isArray(details?.displayAgents) ? details.displayAgents : Array.isArray(details?.agents) ? details.agents : details?.agent ? [details.agent] : [];
	return source.map((value: unknown, index: number) => displayAgent(value, index)).filter((agent): agent is DisplayAgent => agent !== undefined);
}

function displayBatches(details: any): DisplayBatch[] {
	const source = Array.isArray(details?.batches) ? details.batches : details?.batch ? [details.batch] : [];
	return source.map((value: unknown, index: number): DisplayBatch | undefined => {
		if (!isRecord(value) || typeof value.id !== "string") return undefined;
		return {
			id: value.id,
			title: typeof value.title === "string" ? value.title : "Subagent batch",
			sharedPrompt: typeof value.sharedPrompt === "string" ? value.sharedPrompt : undefined,
			role: typeof value.role === "string" ? value.role : undefined,
			parentAgentId: typeof value.parentAgentId === "string" ? value.parentAgentId : undefined,
			memberIds: Array.isArray(value.memberIds) ? value.memberIds.filter((id): id is string => typeof id === "string") : [],
			createdAt: typeof value.createdAt === "number" ? value.createdAt : index,
		};
	}).filter((batch): batch is DisplayBatch => batch !== undefined);
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

function styledState(state: string, theme: Theme, glyph = stateGlyph(state)): string {
	const text = `${glyph} ${state}`;
	if (state === "completed") return theme.fg("success", text);
	if (state === "failed") return theme.fg("error", text);
	if (state === "interrupted" || state === "stopped" || state === "stopping") return theme.fg("warning", text);
	if (state === "running" || state === "starting") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

function isActive(record: AgentRecord): boolean {
	return record.state !== "cold";
}

function isRecentlyFinished(record: AgentRecord, now: number): boolean {
	if (isActive(record) || record.lastOutcome === "none" || record.settledAt === undefined) return false;
	return Math.max(0, now - record.settledAt) < RECENT_FINISHED_WIDGET_MS;
}

function finishedActivity(record: AgentRecord, now: number): string | undefined {
	if (!isRecentlyFinished(record, now)) return undefined;
	const label = record.lastOutcome === "completed"
		? "Finished"
		: record.lastOutcome[0]!.toUpperCase() + record.lastOutcome.slice(1);
	return `${label} <1 min ago`;
}

function contextMeter(record: AgentRecord, theme: Theme): string {
	return contextMeterValues(record.contextWindow, record.contextTokens, theme);
}

function contextMeterValues(contextWindow: number | undefined, contextTokens: number | undefined, theme: Theme): string {
	if (!contextWindow || contextWindow <= 0) return "";
	if (contextTokens === undefined) return theme.fg("muted", `?/${formatTokens(contextWindow)}`);
	const percent = Math.max(0, (contextTokens / contextWindow) * 100);
	const display = `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
	if (percent > 90) return theme.fg("error", display);
	if (percent > 70) return theme.fg("warning", display);
	return theme.fg("muted", display);
}

function widgetLines(
	records: AgentRecord[],
	batches: BatchRecord[],
	theme: Theme,
	now = Date.now(),
	width = Number.POSITIVE_INFINITY,
	includeInactive = false,
): string[] {
	const active = records.filter(isActive);
	const inactive = records.filter((record) => !isActive(record));
	const recentFinished = records.filter((record) => isRecentlyFinished(record, now));
	const completed = inactive.filter((record) => record.lastOutcome === "completed").length;
	const failed = inactive.filter((record) => record.lastOutcome === "failed").length;
	const stopped = inactive.filter((record) => record.lastOutcome === "stopped" || record.lastOutcome === "interrupted").length;
	const activeCost = active.reduce((sum, record) => sum + record.usage.cost, 0);
	const totalCost = records.reduce((sum, record) => sum + record.usage.cost, 0);
	const costSummary = ` · active ${formatCost(activeCost)} · total ${formatCost(totalCost)}`;
	const inactiveParts = [completed ? `${completed} completed` : "", failed ? `${failed} failed` : "", stopped ? `${stopped} stopped` : ""].filter(Boolean).join(" · ");
	if (active.length === 0) {
		const known = records.length === 0 ? "none known" : `${records.length} total${inactiveParts ? ` · ${inactiveParts}` : ""}`;
		if (!includeInactive && recentFinished.length === 0) return [theme.fg("muted", `${theme.bold("Subagents")} · ${known}${costSummary}`)];
	}
	const header = theme.fg("toolTitle", theme.bold("Subagents"))
		+ theme.fg("muted", ` · ${active.length} active · ${inactive.length} inactive${inactiveParts ? ` (${inactiveParts})` : ""}${costSummary}`);
	type WidgetNode = { id: string; parentId?: string; createdAt: number; active: boolean; kind: "agent"; record: AgentRecord }
		| { id: string; parentId?: string; createdAt: number; active: boolean; kind: "batch"; batch: BatchRecord };
	const batchIds = new Set(batches.map((batch) => batch.id));
	const nodes: WidgetNode[] = [
		...batches.map((batch): WidgetNode => ({ id: batch.id, parentId: batch.parentAgentId, createdAt: batch.createdAt, active: includeInactive, kind: "batch", batch })),
		...records.map((record): WidgetNode => ({
			id: record.id,
			parentId: record.batchId && batchIds.has(record.batchId) ? record.batchId : record.parentAgentId,
			createdAt: record.createdAt,
			active: includeInactive || isActive(record) || isRecentlyFinished(record, now),
			kind: "agent",
			record,
		})),
	];
	const tree = buildVisibleTree(nodes, Number.POSITIVE_INFINITY);
	const rows = tree.rows.map(({ item, prefix, isLast }): SubagentDisplayRow => {
		const connector = `${isLast ? "└─" : "├─"} `;
		if (item.kind === "batch") {
			const members = records.filter((record) => item.batch.memberIds.includes(record.id));
			const state = aggregateState(members);
			const cost = members.reduce((sum, record) => sum + record.usage.cost, 0);
			const started = members.map((record) => record.startedAt).filter((value): value is number => value !== undefined);
			const settled = members.map((record) => record.settledAt).filter((value): value is number => value !== undefined);
			const batchEnd = members.some(isActive) ? now : settled.length > 0 ? Math.max(...settled) : now;
			const duration = started.length > 0
				? formatDuration(Math.max(0, batchEnd - Math.min(...started)))
				: "";
			return {
				indent: theme.fg("dim", prefix),
				connector: theme.fg("dim", connector),
				state: styledState(state, theme, "▾"),
				id: theme.fg("accent", item.batch.id),
				role: item.batch.role ? theme.fg("accent", `[${item.batch.role}]`) : "",
				title: theme.bold(oneLine(item.batch.title, 70)),
				model: "",
				context: "",
				duration: duration ? theme.fg("dim", duration) : "",
				cost: cost ? theme.fg("dim", formatCost(cost)) : "",
				cache: "",
				activity: theme.fg("muted", batchActivity(members, item.batch.memberIds.length)),
			};
		}
		const record = item.record;
		const state = record.state === "cold" ? record.lastOutcome : record.state;
		const glyph = state === "running" || state === "starting" || state === "stopping"
			? widgetSpinnerFrame(now)
			: stateGlyph(state);
		const elapsedFrom = record.activeTools.size > 0
			? Math.min(...[...record.activeTools.values()].map((tool) => tool.startedAt))
			: record.startedAt;
		const elapsedUntil = isActive(record) ? now : (record.settledAt ?? now);
		const duration = elapsedFrom ? formatDuration(Math.max(0, elapsedUntil - elapsedFrom)) : "";
		const activity = oneLine(finishedActivity(record, now) ?? currentActivity(record), 70);
		const context = contextMeter(record, theme);
		const cost = record.usage.cost ? formatCost(record.usage.cost) : "";
		const cache = formatCacheHitRate(record.usage.latestCacheHitRate, record.usage.cacheRead > 0 || record.usage.cacheWrite > 0);
		// Activity changes frequently; keep it last so duration and cost remain
		// stable columns while the value itself updates.
		return {
			indent: theme.fg("dim", prefix),
			connector: theme.fg("dim", connector),
			state: styledState(state, theme, glyph),
			id: theme.fg("accent", record.id),
			role: record.role && batches.find((batch) => batch.id === record.batchId)?.role !== record.role ? theme.fg("accent", `[${record.role}]`) : "",
			title: theme.fg("muted", oneLine(record.title, 70)),
			model: theme.fg("dim", `${record.modelRef} [${record.thinking}]`),
			context,
			duration: duration ? theme.fg("dim", duration) : "",
			cost: cost ? theme.fg("dim", cost) : "",
			cache: cache ? theme.fg("dim", cache) : "",
			activity: theme.fg("muted", activity),
		};
	});
	const renderedRows = renderSubagentTable(rows, width);
	if (tree.omitted > 0) renderedRows.push(theme.fg("dim", `… ${tree.omitted} more active/ancestor node${tree.omitted === 1 ? "" : "s"}`));
	return [header, ...renderedRows];
}

function widgetComponent(
	getRecords: () => AgentRecord[],
	getBatches: () => BatchRecord[],
	getRevision: () => number,
	theme: Theme,
	onDispose: () => void,
) {
	let cachedWidth: number | undefined;
	let cachedRevision: number | undefined;
	let cachedClockTick: number | undefined;
	let cachedLines: string[] | undefined;
	const clearCache = () => {
		cachedWidth = undefined;
		cachedRevision = undefined;
		cachedClockTick = undefined;
		cachedLines = undefined;
	};
	return {
		render(width: number): string[] {
			const now = Date.now();
			const revision = getRevision();
			const clockTick = Math.floor(now / WIDGET_CLOCK_REFRESH_MS);
			if (cachedLines && cachedWidth === width && cachedRevision === revision && cachedClockTick === clockTick) return cachedLines;
			const contentWidth = Math.max(0, width - 1);
			cachedLines = widgetLines(getRecords(), getBatches(), theme, now, contentWidth).map((line) => truncateToWidth(` ${line}`, width));
			cachedWidth = width;
			cachedRevision = revision;
			cachedClockTick = clockTick;
			return cachedLines;
		},
		invalidate: clearCache,
		dispose() {
			clearCache();
			onDispose();
		},
	};
}

function widgetFingerprint(records: AgentRecord[], batches: BatchRecord[]): string {
	return JSON.stringify({
		records: records.map((record) => [
			record.id,
			record.title,
			record.modelRef,
			record.thinking,
			record.role,
			record.batchId,
			record.parentAgentId,
			record.createdAt,
			record.state,
			record.lastOutcome,
			record.startedAt,
			record.settledAt,
			record.contextWindow,
			record.contextTokens,
			record.usage.cost,
			record.usage.latestCacheHitRate,
			record.usage.cacheRead,
			record.usage.cacheWrite,
			[...record.activeTools.values()].map((tool) => [tool.name, tool.description, tool.startedAt]),
			record.recent.at(-1)?.at,
			record.recent.at(-1)?.text,
		]),
		batches: batches.map((batch) => [
			batch.id,
			batch.title,
			batch.role,
			batch.parentAgentId,
			batch.createdAt,
			batch.memberIds,
		]),
	});
}

type SubagentDashboardOptions = {
	getRecords: () => AgentRecord[];
	getBatches: () => BatchRecord[];
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender: () => void;
	done: () => void;
	onSend: (record: AgentRecord) => Promise<void>;
	onStop: (record: AgentRecord) => Promise<void>;
	onShowCommand: (record: AgentRecord) => Promise<void>;
};

/** A live browser that uses the same hierarchy rows as the pinned widget. */
class SubagentDashboard {
	private mode: "list" | "status" | "transcript" = "list";
	private selectedId: string | undefined;
	private scrollFromBottom = 0;
	private toolsExpanded = false;
	private notice: { color: "success" | "warning" | "error"; text: string } | undefined;
	private busy = false;
	private closed = false;
	private clock: ReturnType<typeof setInterval>;
	private transcriptKey = "";
	private transcript = new Container();

	constructor(private readonly options: SubagentDashboardOptions) {
		this.syncSelection();
		this.clock = setInterval(() => {
			if (!this.closed) this.options.requestRender();
		}, 1_000);
	}

	handleInput(data: string): void {
		if (this.isCancel(data)) {
			if (this.mode === "list") this.close();
			else {
				this.mode = "list";
				this.scrollFromBottom = 0;
				this.options.requestRender();
			}
			return;
		}

		if (this.mode !== "list") {
			if (this.isUp(data)) this.scrollFromBottom++;
			else if (this.isDown(data)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
			else if (this.options.keybindings.matches(data, "tui.select.pageUp")) this.scrollFromBottom += this.contentHeight();
			else if (this.options.keybindings.matches(data, "tui.select.pageDown")) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - this.contentHeight());
			else if (matchesKey(data, "home")) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
			else if (matchesKey(data, "end") || data === "g" || data === "G") this.scrollFromBottom = 0;
			else if (this.mode === "transcript" && (data === "o" || data === "O")) {
				this.toolsExpanded = !this.toolsExpanded;
				this.transcriptKey = "";
			}
			this.options.requestRender();
			return;
		}

		if (this.isUp(data)) this.moveSelection(-1);
		else if (this.isDown(data)) this.moveSelection(1);
		else if (this.options.keybindings.matches(data, "tui.select.pageUp")) this.moveSelection(-this.contentHeight());
		else if (this.options.keybindings.matches(data, "tui.select.pageDown")) this.moveSelection(this.contentHeight());
		else if (matchesKey(data, "home")) this.selectEdge("first");
		else if (matchesKey(data, "end")) this.selectEdge("last");
		else if (this.isConfirm(data) || data === "t" || data === "T") this.openMode("transcript");
		else if (data === "i" || data === "I") this.openMode("status");
		else if (data === "m" || data === "M") this.runAction("send");
		else if (data === "x" || data === "X") this.runAction("stop");
		else if (data === "c" || data === "C") this.runAction("command");
	}

	render(width: number): string[] {
		this.syncSelection();
		if (width < 4) return [truncateToWidth("subagents", width)];
		return this.mode === "list" ? this.renderList(width) : this.renderDetail(width);
	}

	invalidate(): void {
		this.transcript.invalidate();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.clock);
	}

	private renderList(width: number): string[] {
		const records = this.options.getRecords();
		const innerWidth = width - 2;
		const all = widgetLines(records, this.options.getBatches(), this.options.theme, Date.now(), innerWidth, true);
		const summary = all.shift() ?? "Subagents";
		const selectedIndex = this.selectedId
			? Math.max(0, all.findIndex((line) => line.includes(this.selectedId!)))
			: 0;
		const pageSize = Math.max(1, this.contentHeight() - 2);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(pageSize / 2), all.length - pageSize));
		const visible = all.slice(start, start + pageSize);
		const lines = [
			this.topBorder("/subagents", width),
			this.frame(summary, innerWidth),
			this.separator(width),
		];
		for (const line of visible) {
			const selected = Boolean(this.selectedId && line.includes(this.selectedId));
			const content = this.pad(line, innerWidth);
			lines.push(this.frame(selected ? this.options.theme.bg("selectedBg", content) : content, innerWidth, true));
		}
		if (all.length === 0) lines.push(this.frame(this.options.theme.fg("muted", "No subagents are known."), innerWidth));
		if (all.length > pageSize) lines.push(this.frame(this.options.theme.fg("dim", `${start + 1}–${start + visible.length} of ${all.length}`), innerWidth));
		lines.push(this.separator(width));
		lines.push(this.frame(this.notice
			? this.options.theme.fg(this.notice.color, this.notice.text)
			: this.options.theme.fg("dim", "↑↓/jk select · Enter transcript · i status · m message · x stop · c command · Esc close"), innerWidth));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const record = this.selectedRecord();
		if (!record) {
			this.mode = "list";
			return this.renderList(width);
		}
		const innerWidth = width - 2;
		let content: string[];
		if (this.mode === "transcript") {
			this.refreshTranscript(record);
			content = this.transcript.render(innerWidth).map((line) => truncateToWidth(line, innerWidth));
		} else {
			content = new Text(formatStatus(record), 0, 0).render(innerWidth);
		}
		const height = this.contentHeight();
		const maxScroll = Math.max(0, content.length - height);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
		const start = Math.max(0, content.length - height - this.scrollFromBottom);
		const visible = content.slice(start, start + height);
		const state = record.state === "cold" ? record.lastOutcome : record.state;
		const lines = [
			this.topBorder(`${record.id} · ${record.title}`, width),
			this.frame(`${styledState(state, this.options.theme)}  ${this.options.theme.fg("dim", `${record.modelRef} [${record.thinking}]`)}`, innerWidth),
			this.separator(width),
		];
		for (const line of visible) lines.push(this.frame(line, innerWidth));
		for (let index = visible.length; index < height; index++) lines.push(this.frame("", innerWidth));
		lines.push(this.separator(width));
		const position = content.length > height
			? `${start + 1}–${Math.min(content.length, start + visible.length)} of ${content.length} · `
			: "";
		const hint = this.mode === "transcript"
			? `${position}↑↓/jk scroll · PgUp/PgDn jump · End/G newest · o ${this.toolsExpanded ? "collapse" : "expand"} tools · Esc back`
			: `${position}↑↓/jk scroll · PgUp/PgDn jump · Esc back`;
		lines.push(this.frame(this.options.theme.fg("dim", hint), innerWidth));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private refreshTranscript(record: AgentRecord): void {
		const key = `${record.id}:${record.updatedAt}:${record.state}:${this.toolsExpanded}`;
		if (key === this.transcriptKey) return;
		try {
			const manager = SessionManager.open(record.sessionFile);
			const container = new Container();
			const pendingTools = new Map<string, ToolExecutionComponent>();
			const messages = (manager.getBranch() as any[]).flatMap((entry) => entry?.type === "custom" ? [] : sessionEntryToContextMessages(entry));
			for (const message of messages as any[]) {
				if (message.role === "user") {
					if (container.children.length > 0) container.addChild(new Spacer(1));
					const text = messageText(message);
					if (text) container.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1));
				} else if (message.role === "assistant") {
					container.addChild(new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1));
					for (const part of message.content ?? []) {
						if (part?.type !== "toolCall") continue;
						const component = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false }, undefined, this.options.tui, manager.getCwd());
						component.setExpanded(this.toolsExpanded);
						container.addChild(component);
						pendingTools.set(part.id, component);
					}
				} else if (message.role === "toolResult") {
					const component = pendingTools.get(message.toolCallId);
					if (component) {
						component.updateResult(message);
						pendingTools.delete(message.toolCallId);
					}
				} else if (message.role === "compactionSummary") {
					container.addChild(new Spacer(1));
					const component = new CompactionSummaryMessageComponent(message, getMarkdownTheme());
					component.setExpanded(this.toolsExpanded);
					container.addChild(component);
				} else if (message.role === "branchSummary") {
					container.addChild(new Spacer(1));
					const component = new BranchSummaryMessageComponent(message, getMarkdownTheme());
					component.setExpanded(this.toolsExpanded);
					container.addChild(component);
				} else if (message.role === "bashExecution") {
					const component = new BashExecutionComponent(message.command, this.options.tui, message.excludeFromContext);
					if (message.output) component.appendOutput(message.output);
					component.setComplete(message.exitCode, message.cancelled, message.truncated ? { truncated: true } as any : undefined, message.fullOutputPath);
					component.setExpanded(this.toolsExpanded);
					container.addChild(component);
				}
			}
			if (container.children.length === 0) container.addChild(new Text(this.options.theme.fg("muted", "(No transcript entries yet.)"), 1, 0));
			this.transcript = container;
			this.transcriptKey = key;
		} catch (error) {
			this.transcript = new Container();
			this.transcript.addChild(new Text(this.options.theme.fg("error", `Could not read transcript: ${error instanceof Error ? error.message : String(error)}`), 1, 0));
			this.transcriptKey = key;
		}
	}

	private openMode(mode: "status" | "transcript"): void {
		if (!this.selectedRecord()) return;
		this.mode = mode;
		this.scrollFromBottom = mode === "status" ? Number.MAX_SAFE_INTEGER : 0;
		if (mode === "transcript") this.transcriptKey = "";
		this.options.requestRender();
	}

	private runAction(action: "send" | "stop" | "command"): void {
		const record = this.selectedRecord();
		if (!record || this.busy) return;
		this.busy = true;
		this.notice = { color: "warning", text: action === "send" ? `Messaging ${record.id}…` : action === "stop" ? `Stopping ${record.id}…` : "Preparing command…" };
		this.options.requestRender();
		const operation = action === "send" ? this.options.onSend(record) : action === "stop" ? this.options.onStop(record) : this.options.onShowCommand(record);
		void operation.then(() => {
			this.notice = { color: "success", text: action === "send" ? `Message sent to ${record.id}.` : action === "stop" ? `Stop requested for ${record.id}.` : "Command shown." };
		}).catch((error: unknown) => {
			this.notice = { color: "error", text: error instanceof Error ? error.message : String(error) };
		}).finally(() => {
			this.busy = false;
			if (!this.closed) this.options.requestRender();
		});
	}

	private selectedRecord(): AgentRecord | undefined {
		return this.options.getRecords().find((record) => record.id === this.selectedId);
	}

	private syncSelection(): void {
		const records = this.options.getRecords();
		if (records.length === 0) this.selectedId = undefined;
		else if (!this.selectedId || !records.some((record) => record.id === this.selectedId)) this.selectedId = records.at(-1)!.id;
	}

	private moveSelection(delta: number): void {
		const records = this.options.getRecords();
		if (records.length === 0) return;
		const index = Math.max(0, records.findIndex((record) => record.id === this.selectedId));
		const next = Math.max(0, Math.min(records.length - 1, index + delta));
		this.selectedId = records[next]!.id;
		this.notice = undefined;
		this.options.requestRender();
	}

	private selectEdge(edge: "first" | "last"): void {
		const records = this.options.getRecords();
		const record = edge === "first" ? records[0] : records.at(-1);
		if (!record) return;
		this.selectedId = record.id;
		this.notice = undefined;
		this.options.requestRender();
	}

	private contentHeight(): number {
		return Math.max(5, Math.min(22, Math.floor((process.stdout.rows ?? 30) * 0.85) - 7));
	}

	private isUp(data: string): boolean {
		return data === "k" || data === "K" || this.options.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up");
	}

	private isDown(data: string): boolean {
		return data === "j" || data === "J" || this.options.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down");
	}

	private isConfirm(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "return");
	}

	private isCancel(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
	}

	private topBorder(title: string, width: number): string {
		const innerWidth = width - 2;
		const label = truncateToWidth(` ${title} `, innerWidth, "");
		const rest = Math.max(0, innerWidth - visibleWidth(label));
		return this.options.theme.fg("border", "╭──") + this.options.theme.fg("accent", this.options.theme.bold(label)) + this.options.theme.fg("border", `${"─".repeat(Math.max(0, rest - 2))}╮`);
	}

	private separator(width: number): string {
		return this.options.theme.fg("border", `├${"─".repeat(Math.max(1, width - 2))}┤`);
	}

	private bottomBorder(width: number): string {
		return this.options.theme.fg("border", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
	}

	private frame(text: string, innerWidth: number, padded = false): string {
		const content = padded ? truncateToWidth(text, innerWidth, "") : this.pad(text, innerWidth);
		return this.options.theme.fg("border", "│") + content + this.options.theme.fg("border", "│");
	}

	private pad(text: string, width: number): string {
		const fitted = truncateToWidth(text, width, "…");
		return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.options.done();
	}
}

function hierarchyAgentSnapshot(record: AgentRecord): HierarchyAgentSnapshot {
	return {
		...serializeAgent(record),
		state: record.state,
		lastOutcome: record.lastOutcome,
		currentRunId: record.currentRunId,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		settledAt: record.settledAt,
		lastObservedAt: record.lastObservedAt,
		recent: record.recent.slice(-MAX_RECENT_ACTIVITIES),
		usage: { ...record.usage },
		contextTokens: record.contextTokens,
	};
}

function hierarchyAgentRecord(value: unknown, publishedAt: number): AgentRecord | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.task !== "string") return undefined;
	if (typeof value.modelRef !== "string" || !(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) return undefined;
	if (typeof value.sessionFile !== "string" || typeof value.sandboxDir !== "string" || typeof value.createdAt !== "number") return undefined;
	const serialized = value as unknown as SerializedAgent;
	const record = newRecord(serialized);
	const state = value.state;
	if (state === "queued" || state === "starting" || state === "running" || state === "stopping" || state === "cold") record.state = state;
	const outcome = value.lastOutcome;
	if (outcome === "none" || outcome === "completed" || outcome === "failed" || outcome === "stopped" || outcome === "interrupted") record.lastOutcome = outcome;
	record.currentRunId = typeof value.currentRunId === "string" ? value.currentRunId : undefined;
	record.startedAt = typeof value.startedAt === "number" ? value.startedAt : undefined;
	record.updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : publishedAt;
	record.settledAt = typeof value.settledAt === "number" ? value.settledAt : undefined;
	record.lastObservedAt = typeof value.lastObservedAt === "number" ? value.lastObservedAt : undefined;
	record.contextTokens = typeof value.contextTokens === "number" ? value.contextTokens : undefined;
	if (Array.isArray(value.recent)) {
		record.recent = value.recent.filter((item): item is Activity => isRecord(item) && typeof item.at === "number" && typeof item.text === "string").slice(-MAX_RECENT_ACTIVITIES);
	}
	if (isRecord(value.usage)) {
		record.usage = {
			input: Number(value.usage.input) || 0,
			output: Number(value.usage.output) || 0,
			cacheRead: Number(value.usage.cacheRead) || 0,
			cacheWrite: Number(value.usage.cacheWrite) || 0,
			latestCacheHitRate: typeof value.usage.latestCacheHitRate === "number" ? value.usage.latestCacheHitRate : undefined,
			cost: Number(value.usage.cost) || 0,
			turns: Number(value.usage.turns) || 0,
		};
	}
	if (record.state !== "cold" && Date.now() - publishedAt > HIERARCHY_STALE_MS) {
		record.state = "cold";
		record.lastOutcome = "interrupted";
		record.settledAt = publishedAt;
		addActivity(record, "hierarchy reporter stopped", publishedAt);
	}
	return record;
}

async function publishHierarchySnapshot(registryDir: string, ownerAgentId: string, records: AgentRecord[], batches: BatchRecord[]): Promise<void> {
	await writeHierarchySnapshot(
		registryDir,
		ownerAgentId,
		records.map(hierarchyAgentSnapshot),
		batches.map((batch) => ({ ...batch, memberIds: [...batch.memberIds] })),
	);
}

async function readHierarchySnapshots(
	registryDir: string,
	cache: Map<string, SubagentHierarchySnapshot>,
): Promise<{ records: AgentRecord[]; batches: BatchRecord[] }> {
	const snapshots = await readHierarchyRegistry(registryDir, cache, HIERARCHY_STALE_MS);
	const records: AgentRecord[] = [];
	const batches: BatchRecord[] = [];
	for (const snapshot of snapshots) {
		if (!snapshot) continue;
		for (const value of snapshot.agents) {
			const record = hierarchyAgentRecord(value, snapshot.publishedAt);
			if (record) records.push(record);
		}
		for (const value of snapshot.batches) {
			if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Array.isArray(value.memberIds)) continue;
			batches.push(value as BatchRecord);
		}
	}
	return { records, batches };
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

function agentRows(agents: DisplayAgent[], batches: DisplayBatch[], theme: Theme, expanded: boolean, maxCollapsed = 4, showMoreHint = true): string {
	type DisplayNode = { id: string; parentId?: string; createdAt: number; active: boolean; kind: "agent"; agent: DisplayAgent }
		| { id: string; parentId?: string; createdAt: number; active: boolean; kind: "batch"; batch: DisplayBatch };
	const batchIds = new Set(batches.map((batch) => batch.id));
	const nodes: DisplayNode[] = [
		...batches.map((batch): DisplayNode => ({ id: batch.id, parentId: batch.parentAgentId, createdAt: batch.createdAt, active: true, kind: "batch", batch })),
		...agents.map((agent): DisplayNode => ({ id: agent.id, parentId: agent.batchId && batchIds.has(agent.batchId) ? agent.batchId : agent.parentAgentId, createdAt: agent.createdAt, active: true, kind: "agent", agent })),
	];
	const tree = buildVisibleTree(nodes, expanded ? Math.max(nodes.length, 1) : maxCollapsed);
	const rows = tree.rows.map(({ item, prefix, isLast }): SubagentDisplayRow => {
		const connector = `${isLast ? "└─" : "├─"} `;
		if (item.kind === "batch") {
			const members = agents.filter((agent) => item.batch.memberIds.includes(agent.id));
			const aggregateRecords = members.map((agent) => ({ state: agent.state, lastOutcome: agent.outcome as RunOutcome }));
			const total = Math.max(item.batch.memberIds.length, members.length);
			const partial = members.length < total;
			const state = partial ? "partial" : aggregateState(aggregateRecords);
			const cost = members.reduce((sum, agent) => sum + agent.cost, 0);
			const tokens = members.reduce((sum, agent) => sum + agent.tokens, 0);
			return {
				indent: theme.fg("dim", prefix),
				connector: theme.fg("dim", connector),
				state: styledState(state, theme, "▾"),
				id: theme.fg("accent", item.batch.id),
				role: item.batch.role ? theme.fg("accent", `[${item.batch.role}]`) : "",
				title: theme.bold(oneLine(item.batch.title, 70)),
				model: "",
				context: "",
				duration: "",
				cost: cost > 0 ? theme.fg("dim", formatCost(cost)) : "",
				cache: "",
				activity: theme.fg("dim", `${partial ? `${members.length}/${total} shown · ` : ""}${members.filter((agent) => displayState(agent) === "completed").length}/${partial ? members.length : total} completed${tokens ? ` · ${formatTokens(tokens)} tokens` : ""}${expanded && item.batch.sharedPrompt ? ` · shared: ${oneLine(item.batch.sharedPrompt, 100)}` : ""}`),
			};
		}
		const agent = item.agent;
		const state = displayState(agent);
		const activity = agent.activity && agent.activity !== state ? theme.fg("dim", oneLine(agent.activity, 80)) : "";
		const cost = agent.cost > 0 ? theme.fg("dim", formatCost(agent.cost)) : "";
		const model = agent.model ? theme.fg("dim", `${agent.model}${agent.thinking ? ` [${agent.thinking}]` : ""}`) : "";
		const context = contextMeterValues(agent.contextWindow, agent.contextTokens, theme);
		const cache = formatCacheHitRate(agent.cacheHitRate, agent.hasCacheUsage);
		const duration = agent.durationMs === undefined ? "" : theme.fg("dim", formatDuration(agent.durationMs));
		return {
			indent: theme.fg("dim", prefix),
			connector: theme.fg("dim", connector),
			state: styledState(state, theme),
			id: theme.fg("accent", agent.id),
			role: agent.role && batches.find((batch) => batch.id === agent.batchId)?.role !== agent.role ? theme.fg("accent", `[${agent.role}]`) : "",
			title: theme.fg("muted", oneLine(agent.title, 70)),
			model,
			context,
			duration,
			cost,
			cache: cache ? theme.fg("dim", cache) : "",
			activity,
		};
	});
	const renderedRows = renderSubagentTable(rows, Number.POSITIVE_INFINITY);
	if (tree.omitted > 0 && showMoreHint) renderedRows.push(theme.fg("dim", `… ${tree.omitted} more (${keyHint("app.tools.expand", "details")})`));
	return renderedRows.join("\n");
}

function toolHeader(label: string, detail: string, theme: Theme, lastComponent?: unknown): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", theme.bold(label)) + (detail ? ` ${theme.fg("muted", detail)}` : ""));
	return component;
}

function agentSummaryResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown, verb = "Subagents"): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	const agents = displayAgents(resultValue?.details);
	const batches = displayBatches(resultValue?.details);
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
	const omitted = Number(resultValue?.details?.omittedAgents ?? 0);
	const summary = `${prefix}${counts ? ` · ${counts}` : ""}${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}${omitted > 0 ? ` · ${omitted} older omitted` : ""}`;
	component.setText(`${summary}\n${agentRows(agents, batches, theme, options.expanded)}`);
	return component;
}

function completionSummaryResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown) {
	if (options.isError) return textOrMarkdownResult(resultValue, options, theme, lastComponent);
	if (options.isPartial) return agentSummaryResult(resultValue, options, theme, lastComponent, "Waiting");
	if (options.expanded) return new Markdown(resultText(resultValue), 0, 0, getMarkdownTheme());
	const agents = displayAgents(resultValue?.details);
	const batches = displayBatches(resultValue?.details);
	const pendingAgents = displayAgents({ agents: resultValue?.details?.pendingAgents })
		.filter((pending) => !agents.some((agent) => agent.id === pending.id));
	const displayedAgents = [...agents, ...pendingAgents];
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	if (displayedAgents.length === 0) {
		component.setText(theme.fg("muted", oneLine(resultText(resultValue), 500)));
		return component;
	}
	const anyMode = resultValue?.details?.waitMode === "any";
	const pendingCount = pendingAgents.length > 0
		? pendingAgents.length
		: Array.isArray(resultValue?.details?.pendingAgents) ? resultValue.details.pendingAgents.length : 0;
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
	component.setText(`${headline}${metrics}\n${agentRows(displayedAgents, batches, theme, false, 12, false)}${displayedAgents.length + batches.length > 12 ? `\n${theme.fg("dim", `… ${displayedAgents.length + batches.length - 12} more`)}` : ""}${pending}\n${theme.fg("dim", keyHint("app.tools.expand", anyMode ? "first result details" : "full batch results"))}`);
	return component;
}

/**
 * The pinned widget is the canonical live hierarchy. Keep the wait tool's
 * collapsed result deliberately compact so it does not render the same tree
 * a second time below the conversation. Expanded waits still expose the full
 * completion report through completionSummaryResult.
 */
function waitSummaryResult(resultValue: any, options: { expanded: boolean; isPartial: boolean; isError?: boolean }, theme: Theme, lastComponent?: unknown): Text | ReturnType<typeof completionSummaryResult> {
	const noEligibleAgents = resultValue?.details?.noEligibleAgents === true;
	const parentReport = resultValue?.details?.parentReport;
	if (options.expanded && !options.isPartial && !resultValue?.details?.timedOut && !noEligibleAgents && !parentReport) {
		return completionSummaryResult(resultValue, options, theme, lastComponent);
	}
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	if (options.isError) {
		component.setText(theme.fg("error", `! ${oneLine(resultText(resultValue) || "Wait failed", 500)}`));
		return component;
	}
	if (noEligibleAgents) {
		component.setText(theme.fg("muted", "· No active direct subagents or undelivered results"));
		return component;
	}
	const agents = displayAgents(resultValue?.details);
	const pending = displayAgents({ agents: resultValue?.details?.pendingAgents });
	if (!options.isPartial && isRecord(parentReport) && typeof parentReport.id === "string" && typeof parentReport.message === "string") {
		const pendingText = pending.length > 0 ? `\n${theme.fg("dim", `${pending.length} still running`)}` : "";
		component.setText(`${theme.fg("warning", `◆ Mid-task report · ${parentReport.id}`)}\n${oneLine(parentReport.message, 500)}${pendingText}`);
		return component;
	}
	const timedOut = resultValue?.details?.timedOut === true;
	const failures = agents.filter((agent) => displayState(agent) === "failed").length;
	const settled = agents.filter((agent) => displayState(agent) === "completed" || displayState(agent) === "failed" || displayState(agent) === "stopped" || displayState(agent) === "interrupted").length;
	const active = agents.filter((agent) => displayState(agent) === "running" || displayState(agent) === "starting" || displayState(agent) === "queued" || displayState(agent) === "accepted").length;
	const totalCost = agents.reduce((sum, agent) => sum + agent.cost, 0);
	const mode = resultValue?.details?.waitMode === "any" ? "first result" : "all results";
	const prefix = timedOut
		? theme.fg("warning", "◷ Wait timed out")
		: options.isPartial
			? theme.fg("accent", "◐ Waiting")
			: failures > 0
				? theme.fg("warning", "◆ Wait finished")
				: theme.fg("success", "✓ Wait finished");
	const counts = timedOut || options.isPartial
		? `${pending.length || active} still running`
		: `${settled} settled`;
	const metrics = `${totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}${failures > 0 ? ` · ${failures} exceptional` : ""}`;
	component.setText(`${prefix} · ${mode} · ${counts}${metrics}\n${theme.fg("dim", "Live hierarchy is shown in the pinned Subagents widget")}`);
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

async function resolveIds(params: { ids?: string[]; batch_id?: string; input_file?: string }, cwd: string, manager: SubagentManager): Promise<string[]> {
	if (params.input_file !== undefined) {
		if (params.ids !== undefined || params.batch_id !== undefined) throw new Error("ids, batch_id, and input_file are mutually exclusive");
		const loaded = await readJsonFile(params.input_file, cwd);
		const ids = idsFromHandleFileValue(loaded.value);
		if (ids.length === 0) throw new Error("input_file did not contain any subagent handles");
		return [...new Set(ids)];
	}
	if (params.batch_id !== undefined) {
		if (params.ids !== undefined) throw new Error("ids and batch_id are mutually exclusive");
		const batchId = cleanText(params.batch_id);
		if (!batchId) throw new Error("batch_id must not be empty");
		return manager.batchMembers(batchId).map((record) => record.id);
	}
	if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error("ids is required and must not be empty");
	const ids = [...new Set(params.ids.map((id) => cleanText(id)).filter(Boolean))];
	if (ids.length === 0) throw new Error("ids must contain at least one non-empty ID");
	return ids;
}

async function resolveWaitIds(
	params: { ids?: string[]; batch_id?: string; input_file?: string },
	cwd: string,
	manager: SubagentManager,
	mode: WaitMode,
): Promise<string[]> {
	const hasSelector = params.ids !== undefined || params.batch_id !== undefined || params.input_file !== undefined;
	if (hasSelector) return resolveIds(params, cwd, manager);
	if (mode !== "any") throw new Error("ids, batch_id, or input_file is required for wait_mode \"all\"");
	return implicitAnyWaitCandidates(manager.list()).map((record) => record.id);
}

export default async function subagentsExtension(pi: ExtensionAPI) {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const roles = await loadSubagentRoles(path.join(extensionDir, "roles"), path.join(extensionDir, "profiles"));
	const compactionPolicy = await loadManagedSubagentCompactionPolicy(process.cwd());
	pi.on("before_provider_request", (event) => {
		const promptCacheKey = process.env[PROMPT_CACHE_ENV];
		if (!promptCacheKey || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		if (Object.hasOwn(payload, "prompt_cache_key")) return { ...payload, prompt_cache_key: promptCacheKey };
		if (Object.hasOwn(payload, "promptCacheKey")) return { ...payload, promptCacheKey };
	});

	// Managed children keep their compact completion behavior and can also
	// orchestrate managed descendants through the tools registered below.
	if (process.env[MANAGED_CHILD_ENV] === "1") {
		// Keep overflow recovery intact, but do not spend another model call
		// summarizing a successful answer immediately before this child exits.
		// A cold continuation performs the deferred compaction before its prompt.
		let lastAssistantStopReason: string | undefined;
		let continueAfterCompaction = false;
		pi.on("message_end", (event) => {
			if (event.message?.role === "assistant") lastAssistantStopReason = event.message.stopReason;
		});
		pi.on("session_before_compact", (event) => {
			continueAfterCompaction = shouldContinueManagedSubagentAfterCompaction(event, lastAssistantStopReason);
			if (shouldCancelManagedSubagentCompaction(event, lastAssistantStopReason)) return { cancel: true };
		});
		pi.on("session_compact", (event) => {
			if (!continueAfterCompaction || event.willRetry) return;
			continueAfterCompaction = false;
			pi.sendUserMessage(
				"Continue the interrupted task from the compacted context. Finish the work and return the originally requested final answer.",
				{ deliverAs: "followUp" },
			);
		});
	}

	let manager: SubagentManager | undefined;
	let latestCtx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	const currentAgentId = process.env[CURRENT_AGENT_ENV] || undefined;
	let hierarchyRegistryDir = process.env[HIERARCHY_REGISTRY_ENV] || undefined;
	let hierarchyRecords: AgentRecord[] = [];
	let hierarchyBatches: BatchRecord[] = [];
	const hierarchySnapshotCache = new Map<string, SubagentHierarchySnapshot>();
	let hierarchyTimer: ReturnType<typeof setInterval> | undefined;
	let hierarchyPublishTimer: ReturnType<typeof setTimeout> | undefined;
	let hierarchyPublishing = false;
	let hierarchyRefreshing = false;
	let hierarchyPublishedFingerprint: string | undefined;
	const pendingParentReports: PendingParentMessage[] = [];
	let parentReportFlushScheduled = false;
	let completionFlushScheduled = false;
	let completionFlushRunning = false;
	let widgetInstalled = false;
	let widgetRecords: AgentRecord[] = [];
	let widgetBatches: BatchRecord[] = [];
	let widgetRevision = 0;
	let widgetStateFingerprint = "";
	let widgetTui: Pick<TUI, "requestRender"> | undefined;
	let widgetStateTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetAnimationTimer: ReturnType<typeof setInterval> | undefined;
	let widgetClockTimer: ReturnType<typeof setInterval> | undefined;
	let shuttingDown = false;

	const mergedById = <T extends { id: string }>(local: T[], remote: T[]): T[] => {
		const values = new Map<string, T>();
		for (const item of remote) values.set(item.id, item);
		for (const item of local) values.set(item.id, item);
		return [...values.values()].sort((left: any, right: any) => Number(left.createdAt) - Number(right.createdAt));
	};

	const publishCurrentHierarchy = async () => {
		if (!currentAgentId || !hierarchyRegistryDir || !manager || hierarchyPublishing || shuttingDown) return;
		const records = manager.list();
		const batches = manager.listBatches();
		const fingerprint = JSON.stringify({
			agents: records.map(hierarchyAgentSnapshot),
			batches: batches.map((batch) => ({ ...batch, memberIds: [...batch.memberIds] })),
		});
		if (!records.some(isActive) && fingerprint === hierarchyPublishedFingerprint) return;
		hierarchyPublishing = true;
		try {
			await publishHierarchySnapshot(hierarchyRegistryDir, currentAgentId, records, batches);
			hierarchyPublishedFingerprint = fingerprint;
		} catch {
			// The widget is optional. Do not fail an agent run for reporting errors.
		} finally {
			hierarchyPublishing = false;
		}
	};

	const scheduleHierarchyPublish = () => {
		if (!currentAgentId || !hierarchyRegistryDir || hierarchyPublishTimer || shuttingDown) return;
		hierarchyPublishTimer = setTimeout(() => {
			hierarchyPublishTimer = undefined;
			void publishCurrentHierarchy();
		}, WIDGET_STATE_REFRESH_MS);
	};

	const refreshHierarchy = async () => {
		if (currentAgentId || !hierarchyRegistryDir || hierarchyRefreshing || shuttingDown) return;
		hierarchyRefreshing = true;
		try {
			const hierarchy = await readHierarchySnapshots(hierarchyRegistryDir, hierarchySnapshotCache);
			hierarchyRecords = hierarchy.records;
			hierarchyBatches = hierarchy.batches;
			refreshWidget();
		} finally {
			hierarchyRefreshing = false;
		}
	};

	const clearWidgetTimers = () => {
		if (widgetStateTimer) clearTimeout(widgetStateTimer);
		if (widgetAnimationTimer) clearInterval(widgetAnimationTimer);
		if (widgetClockTimer) clearInterval(widgetClockTimer);
		widgetStateTimer = undefined;
		widgetAnimationTimer = undefined;
		widgetClockTimer = undefined;
	};

	const syncWidgetTimers = () => {
		const hasActive = widgetRecords.some(isActive);
		const hasRecentFinished = widgetRecords.some((record) => isRecentlyFinished(record, Date.now()));
		if (hasActive) {
			if (!widgetAnimationTimer) widgetAnimationTimer = setInterval(() => widgetTui?.requestRender(), WIDGET_CLOCK_REFRESH_MS);
			if (widgetClockTimer) clearInterval(widgetClockTimer);
			widgetClockTimer = undefined;
			return;
		}
		if (widgetAnimationTimer) clearInterval(widgetAnimationTimer);
		widgetAnimationTimer = undefined;
		if (hasRecentFinished && !widgetClockTimer) {
			widgetClockTimer = setInterval(() => {
				widgetTui?.requestRender();
				syncWidgetTimers();
			}, WIDGET_CLOCK_REFRESH_MS);
		} else if (!hasRecentFinished && widgetClockTimer) {
			clearInterval(widgetClockTimer);
			widgetClockTimer = undefined;
		}
	};

	const refreshWidget = () => {
		if (!latestCtx || latestCtx.mode !== "tui" || shuttingDown) return;
		const nextRecords = mergedById(manager?.list() ?? [], hierarchyRecords);
		const nextBatches = mergedById(manager?.listBatches() ?? [], hierarchyBatches);
		const nextFingerprint = widgetFingerprint(nextRecords, nextBatches);
		const stateChanged = nextFingerprint !== widgetStateFingerprint;
		if (stateChanged) {
			widgetRecords = nextRecords;
			widgetBatches = nextBatches;
			widgetStateFingerprint = nextFingerprint;
			widgetRevision++;
		}
		if (widgetRecords.length === 0) {
			if (widgetInstalled) latestCtx.ui.setWidget(WIDGET_ID, undefined);
			widgetInstalled = false;
			widgetTui = undefined;
			clearWidgetTimers();
			return;
		}
		if (!widgetInstalled) {
			// Keep one component. Later state changes only request a render.
			widgetInstalled = true;
			latestCtx.ui.setWidget(WIDGET_ID, (tui, theme) => {
				widgetTui = tui;
				return widgetComponent(
					() => widgetRecords,
					() => widgetBatches,
					() => widgetRevision,
					theme,
					() => { if (widgetTui === tui) widgetTui = undefined; },
				);
			});
		} else if (stateChanged) {
			widgetTui?.requestRender();
		}
		syncWidgetTimers();
	};

	const scheduleWidgetRefresh = () => {
		if (widgetStateTimer || shuttingDown || latestCtx?.mode !== "tui") return;
		widgetStateTimer = setTimeout(() => {
			widgetStateTimer = undefined;
			refreshWidget();
		}, WIDGET_STATE_REFRESH_MS);
	};

	const flushParentReports = (opportunity: ParentReportDeliveryOpportunity): boolean => {
		if (shuttingDown || pendingParentReports.length === 0) return false;
		const reports = takeParentReportBatch(pendingParentReports, opportunity);
		if (reports.length === 0) return false;
		const content = reports.length === 1
			? `Mid-task message from ${reports[0]!.id} · ${reports[0]!.title}:\n\n${reports[0]!.message}`
			: `Mid-task reports (${reports.length}):\n\n${reports.map((report, index) => `${index + 1}. ${report.id} · ${report.title}\n${report.message}`).join("\n\n")}`;
		const deliverAs = opportunity === "turn_end" ? "steer" : "followUp";
		const reportDetails = reports.map((report) => ({
			agentId: report.id,
			title: report.title,
			message: report.message,
			delivery: report.delivery,
		}));
		try {
			pi.sendMessage({
				customType: "subagent-parent-report",
				content,
				display: true,
				details: {
					reports: reportDetails,
					...(reportDetails.length === 1 ? reportDetails[0] : {}),
				},
			}, { deliverAs, triggerTurn: true });
			return true;
		} catch (error) {
			pendingParentReports.unshift(...reports);
			if (latestCtx?.hasUI) latestCtx.ui.notify(`Could not deliver subagent report: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	};

	const scheduleParentReportFlush = () => {
		if (parentReportFlushScheduled || shuttingDown || !latestCtx?.isIdle()) return;
		parentReportFlushScheduled = true;
		queueMicrotask(() => {
			parentReportFlushScheduled = false;
			flushParentReports("idle");
		});
	};

	const flushCompletions = async () => {
		if (completionFlushRunning || shuttingDown || !latestCtx?.isIdle() || !manager) return;
		const deliverable = manager.getDeliverable();
		if (deliverable.length === 0) return;
		completionFlushRunning = true;
		const claimedRuns = deliverable.map((record) => ({ id: record.id, runId: record.currentRunId }));
		let flushed = false;
		try {
			const batchIds = new Set(deliverable.map((record) => record.batchId).filter((id): id is string => Boolean(id)));
			const completion = await buildCompletionResult(
				deliverable.map((record) => record.latestCompletion ?? completionSnapshot(record)),
				"pi-subagent-completions",
				undefined,
				manager.listBatches().filter((batch) => batchIds.has(batch.id)),
			);
			pi.sendMessage({
				customType: "subagent-completions",
				content: resultText(completion),
				display: true,
				details: completion.details,
			}, { deliverAs: "followUp", triggerTurn: true });
			manager.markDelivered(claimedRuns);
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
		manager = new SubagentManager(ctx.cwd, compactionPolicy, hierarchyRegistryDir);
		manager.restore(scanSerializedAgents(ctx).map((item) => item.contextWindow
			? item
			: { ...item, contextWindow: modelContextWindow(ctx, item.modelRef) }), scanSerializedBatches(ctx));
		unsubscribe = manager.subscribe((event) => {
			scheduleWidgetRefresh();
			scheduleHierarchyPublish();
			if (event.kind === "settled") scheduleCompletionFlush();
			if (event.kind === "parent_message" && !event.interruptedWait) {
				const record = manager!.get(event.id);
				pendingParentReports.push({ id: record.id, title: record.title, message: event.message, delivery: event.delivery });
				scheduleParentReportFlush();
			}
		});
		refreshWidget();
		scheduleHierarchyPublish();
		return manager;
	};

	pi.on("turn_end", (_event, ctx) => {
		latestCtx = ctx;
		flushParentReports("turn_end");
	});

	// A child can settle while the parent is in the middle of a run, when
	// follow-up delivery is intentionally deferred. Re-check as soon as that
	// parent run ends so completed results are not stranded indefinitely.
	pi.on("agent_end", (_event, ctx) => {
		latestCtx = ctx;
		flushParentReports("agent_end");
		queueMicrotask(scheduleCompletionFlush);
	});

	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${buildMainInstructions(roles, Boolean(currentAgentId))}` }));
	const AgentSpecSchema = Type.Object({
		title: Type.String({ minLength: 1, description: "Short human-readable subagent title." }),
		task: Type.String({ minLength: 1, description: "Complete individual task for this subagent." }),
		model: Type.String({ minLength: 1, description: "Required exact provider/model-id. Never inherited or loosely matched." }),
		thinking: StringEnum(THINKING_LEVELS, { description: "Required explicit Pi thinking level." }),
		role: Type.Optional(Type.String({ minLength: 1, description: `Optional role. Available: ${[...roles.keys()].join(", ") || "none"}.` })),
		cwd: Type.Optional(Type.String({ minLength: 1, description: "Optional child working directory. Relative paths resolve from the parent working directory. Use this to place an agent in an existing Git worktree. Nested subagents inherit this directory. Defaults to the parent working directory." })),
		context: Type.Optional(StringEnum(CONTEXT_MODES, { description: "Context mode; defaults to fresh." })),
		context_files: Type.Optional(Type.Boolean({ description: "Whether child Pi discovers AGENTS.md and CLAUDE.md context files. Defaults to true. Set false to ignore context files; this does not restrict filesystem access or disable other project resources." })),
		system_prompt: Type.Optional(Type.String({ minLength: 1, description: "Optional additional system prompt; fresh context only." })),
		system_prompt_file: Type.Optional(Type.String({ minLength: 1, description: "Optional UTF-8 additional system prompt file; fresh context only." })),
	}, { additionalProperties: false });
	const BatchSchema = Type.Object({
		title: Type.String({ minLength: 1, description: "Human-readable batch title." }),
		shared_prompt: Type.String({ minLength: 1, maxLength: MAX_SHARED_PROMPT_BYTES, description: "Assignment context injected into every batch member." }),
		role: Type.Optional(Type.String({ minLength: 1, description: `Optional role inherited by members that do not specify one. Available: ${[...roles.keys()].join(", ") || "none"}.` })),
		context_files: Type.Optional(Type.Boolean({ description: "Default context-file discovery for batch members. Defaults to true; an agent-level value overrides it." })),
		agents: Type.Array(AgentSpecSchema, { minItems: 1, description: "Agents with individual tasks. An agent role overrides the batch role." }),
	}, { additionalProperties: false });

	pi.registerTool({
		name: START_TOOL_NAME,
		label: "Start Subagent",
		description: `Start one managed Pi subagent or one formal batch and return immediately. Each agent can use an optional working directory, such as an existing Git worktree. Exact provider/model-id and thinking are required for every agent. Roles are optional (${[...roles.keys()].join(", ") || "none available"}). Supply single-agent fields, batch by itself, or input_file by itself containing the same request shape.`,
		parameters: Type.Object({
			input_file: Type.Optional(Type.String({ description: "JSON file containing the same single-or-batch request object used inline. Must be supplied by itself." })),
			batch: Type.Optional(BatchSchema),
			title: Type.Optional(Type.String({ description: "Short human-readable subagent title. Required inline." })),
			task: Type.Optional(Type.String({ description: "Complete task for this subagent. Required inline." })),
			model: Type.Optional(Type.String({ description: "Required exact provider/model-id. Never inherited or loosely matched." })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Required explicit Pi thinking level." })),
			role: Type.Optional(Type.String({ description: `Optional role whose instructions are injected into the child system prompt. Available: ${[...roles.keys()].join(", ") || "none"}.` })),
			cwd: Type.Optional(Type.String({ description: "Optional child working directory. Relative paths resolve from the parent working directory. Use this to place an agent in an existing Git worktree. Nested subagents inherit this directory. Defaults to the parent working directory." })),
			context: Type.Optional(StringEnum(CONTEXT_MODES, { description: "Context mode; defaults to fresh." })),
			context_files: Type.Optional(Type.Boolean({ description: "Whether child Pi discovers AGENTS.md and CLAUDE.md context files. Defaults to true. Set false to ignore context files; this does not restrict filesystem access or disable other project resources." })),
			system_prompt: Type.Optional(Type.String({ description: "Optional additional system prompt; fresh context only." })),
			system_prompt_file: Type.Optional(Type.String({ description: "Optional UTF-8 additional system prompt file; fresh context only." })),
		}, { additionalProperties: false }),
		prepareArguments(args) {
			return normalizeLegacyStartValue(args);
		},
		async execute(_id, params: StartToolParams, signal, _onUpdate, ctx) {
			const prepared: PreparedAgent[] = [];
			let addedCount = 0;
			try {
				if (signal?.aborted) throw new Error("Subagent start aborted before preparation");
				const resolved = await resolveStartRequest(params, ctx.cwd);
				const batchId = resolved.batch ? `batch-${randomUUID().slice(0, 8)}` : undefined;
				// Validate the complete request before creating any child session files.
				if (resolved.batch?.role) exactRole(roles, resolved.batch.role);
				for (const spec of resolved.specs) {
					const model = exactModel(ctx, spec.model);
					validateThinking(model, spec.thinking);
					const role = exactRole(roles, spec.role);
					spec.cwd = await resolveSubagentCwd(spec.cwd, ctx.cwd);
					await combinedSystemPrompt(spec, role, ctx.cwd);
				}
				for (const spec of resolved.specs) {
					if (signal?.aborted) throw new Error("Subagent start aborted during preparation");
					const role = exactRole(roles, spec.role);
					if (role) spec.role = role.name;
					prepared.push(await prepareAgent(spec, ctx, role, resolved.batch?.shared_prompt, batchId));
				}
				if (signal?.aborted) throw new Error("Subagent start aborted during preparation");
				const activeManager = ensureManager(ctx);
				let batchRecord: BatchRecord | undefined;
				if (resolved.batch && batchId) {
					batchRecord = {
						id: batchId,
						title: sanitizeTitle(resolved.batch.title),
						sharedPrompt: cleanText(resolved.batch.shared_prompt),
						role: exactRole(roles, resolved.batch.role)?.name,
						parentAgentId: process.env[CURRENT_AGENT_ENV] || undefined,
						memberIds: prepared.map((item) => item.record.id),
						createdAt: Math.min(...prepared.map((item) => item.record.createdAt)),
					};
				}
				const records = activeManager.addMany(prepared, batchRecord);
				addedCount = records.length;
				const serialized = records.map(serializeAgent);
				let text: string;
				let handlesFile: string | undefined;
				if (records.length <= NORMAL_LAUNCH_DETAIL_LIMIT) {
					text = `${batchRecord ? `Started batch ${batchRecord.id} · ${batchRecord.title}\n${records.length} members` : `Started ${records.length} subagent${records.length === 1 ? "" : "s"}`}\n\n${records.map((record) => `${record.id} · ${record.title}\n  ${record.modelRef} [${record.thinking}]${record.role ? ` · role ${record.role}` : ""}${record.contextFiles ? "" : " · context files disabled"}\n  cwd: ${record.cwd}\n  ${record.state} · session: ${record.sessionFile}`).join("\n\n")}`;
				} else {
					handlesFile = path.join(tmpdir(), `pi-subagent-handles-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
					const running = records.length;
					try {
						await writeFile(handlesFile, `${JSON.stringify({ batch: batchRecord, agents: serialized }, null, 2)}\n`, "utf8");
						text = `Accepted ${records.length} subagents.${batchRecord ? `\nBatch: ${batchRecord.id} · ${batchRecord.title}` : ""}\nStarting/running: ${running}\nQueued internally: 0\nHandle list saved to: ${handlesFile}`;
					} catch (error) {
						handlesFile = undefined;
						text = `Accepted ${records.length} subagents.${batchRecord ? `\nBatch: ${batchRecord.id} · ${batchRecord.title}` : ""}\nStarting/running: ${running}\nQueued internally: 0\nWarning: the compact handle file could not be written (${error instanceof Error ? error.message : String(error)}). Handles remain preserved in this tool result's details.`;
					}
				}
				if (resolved.manifest) text += `\nInput: ${resolved.manifest.path} · ${resolved.manifest.bytes.toLocaleString("en-US")} bytes · SHA-256 ${resolved.manifest.sha256}`;
				return result(text, { agents: serialized, displayAgents: records.map(compactRecord), batches: batchRecord ? [batchRecord] : [], batchId: batchRecord?.id, handlesFile, manifest: resolved.manifest });
			} catch (error) {
				await cleanupPreparedAgents(prepared.slice(addedCount));
				throw new Error(`Subagents were not started: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const detail = typeof input?.input_file === "string"
				? `manifest ${path.basename(input.input_file)}`
				: input?.batch
					? `${oneLine(input.batch.title ?? "batch", 60)} · ${Array.isArray(input.batch.agents) ? input.batch.agents.length : "?"} agents${input.batch.role ? ` · [${input.batch.role}]` : ""}`
					: `${oneLine(input?.title ?? "subagent", 60)}${input?.model ? ` · ${input.model}${input.thinking ? ` [${input.thinking}]` : ""}` : ""}${input?.role ? ` · [${input.role}]` : ""}`;
			return toolHeader("Start subagent", detail, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return agentSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent, options.isPartial ? "Starting" : "Accepted");
		},
	});

	pi.registerTool({
		name: LIST_TOOL_NAME,
		label: "List Subagents",
		description: `List the ${MAX_LISTED_SUBAGENTS} most recently created managed subagents. Reports how many older subagents it omits. Does not return transcripts, raw tool output, or full final answers.`,
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const activeManager = ensureManager(ctx);
			const allRecords = activeManager.list();
			const recent = takeRecent(allRecords);
			const records = recent.items;
			const batchIds = new Set(records.map((record) => record.batchId).filter((id): id is string => Boolean(id)));
			const batches = activeManager.listBatches().filter((batch) => batchIds.has(batch.id));
			const omissionNotice = recent.omitted > 0
				? `Showing the ${records.length} most recent subagents. ${recent.omitted} older subagent${recent.omitted === 1 ? " is" : "s are"} not included.\n\n`
				: "";
			const formatted = `${omissionNotice}${formatList(records, batches)}`;
			const truncated = truncateHead(formatted);
			return result(truncated.content, {
				agents: records.map(compactRecord),
				batches: batches.map(compactBatch),
				totalAgents: allRecords.length,
				omittedAgents: recent.omitted,
				listLimit: MAX_LISTED_SUBAGENTS,
				truncated: truncated.truncated || recent.omitted > 0,
			});
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
		description: "Return accurate compact status for selected subagents by ids, formal batch_id, or handle file: active tools, last observed activity, recent compact activity, usage, and session path. Never returns transcript or raw tool output.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
			batch_id: Type.Optional(Type.String({ minLength: 1, description: "Select every member of one formal batch. Mutually exclusive with ids and input_file." })),
			input_file: Type.Optional(Type.String({ description: "Handle JSON file returned by a large subagent_start call. Mutually exclusive with ids and batch_id." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const activeManager = ensureManager(ctx);
				const ids = await resolveIds(params, ctx.cwd, activeManager);
				const records = ids.map((id) => activeManager.get(id));
				const batchIds = new Set(records.map((record) => record.batchId).filter((id): id is string => Boolean(id)));
				const batches = activeManager.listBatches().filter((batch) => batchIds.has(batch.id));
				return result(records.map(formatStatus).join("\n\n---\n\n"), { agents: records.map(compactRecord), batches: batches.map(compactBatch) });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const ids = Array.isArray((args as any)?.ids) ? (args as any).ids : [];
			const batchId = (args as any)?.batch_id;
			const inputFile = (args as any)?.input_file;
			return toolHeader("Subagent status", batchId || (inputFile ? `manifest ${path.basename(inputFile)}` : ids.length === 1 ? ids[0] : `${ids.length} agents`), theme, context.lastComponent);
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
		batch_id: Type.Optional(Type.String({ minLength: 1, description: "Select every member of one formal batch." })),
		input_file: Type.Optional(Type.String({ description: "Handle JSON file returned by a large subagent_start call. Mutually exclusive with ids and batch_id." })),
	});

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: "Wait for Subagents",
		description: "Wait for subagents by ids, formal batch_id, or handle file. A mid-task report from a selected subagent ends the wait immediately. Omit selectors with wait_mode \"any\" to wait for the next result from any active direct subagent. wait_mode \"all\" requires a selector and returns every selected result. An \"any\" wait returns only new results and leaves the rest running. Cancellation, timeout, or a report leaves unfinished subagents running.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Selected subagent IDs. Omit every selector with wait_mode any to use all active direct subagents." })),
			batch_id: Type.Optional(Type.String({ minLength: 1, description: "Select every member of one formal batch. Mutually exclusive with ids and input_file." })),
			input_file: Type.Optional(Type.String({ description: "Handle JSON file returned by a large subagent_start call. Mutually exclusive with ids and batch_id." })),
			wait_mode: StringEnum(["all", "any"] as const, { description: "Required: all waits for every selected agent; any waits for the next undelivered completion. Omit selectors with any to use all active direct subagents." }),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const activeManager = ensureManager(ctx);
				if (params.wait_mode !== "all" && params.wait_mode !== "any") throw new Error("wait_mode is required and must be \"all\" or \"any\"");
				const waitMode = params.wait_mode as WaitMode;
				const ids = await resolveWaitIds(params, ctx.cwd, activeManager, waitMode);
				if (ids.length === 0) {
					return result("No active direct subagents or undelivered results are available.", {
						agents: [],
						batches: [],
						pendingAgents: [],
						waitMode,
						noEligibleAgents: true,
					});
				}
				const selectedRecords = ids.map((id) => activeManager.get(id));
				const selectedBatchIds = new Set(selectedRecords.map((record) => record.batchId).filter((id): id is string => Boolean(id)));
				const selectedBatches = activeManager.listBatches().filter((batch) => selectedBatchIds.has(batch.id));
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
					onUpdate?.(result(formatList(records, selectedBatches), { agents: records.map(compactRecord), batches: selectedBatches.map(compactBatch) }));
				}, 1_000);
				try {
					const waited = await activeManager.wait(ids, waitController.signal, true, waitMode);
					if (waited.report) {
						const source = activeManager.get(waited.report.id);
						const pendingText = waited.pending.length > 0
							? `\n\nStill running (${waited.pending.length}):\n${formatList(waited.pending, selectedBatches)}`
							: "";
						return result(`Wait ended by a mid-task report from ${source.id} · ${source.title}:\n\n${waited.report.message}${pendingText}`, {
							agents: selectedRecords.map(compactRecord),
							batches: selectedBatches.map(compactBatch),
							pendingAgents: waited.pending.map(compactRecord),
							waitMode,
							parentReport: waited.report,
						});
					}
					const snapshots = waited.settled.map((record) => record.latestCompletion ?? completionSnapshot(record));
					const completion = await buildCompletionResult(
						snapshots,
						waitMode === "any" ? "pi-subagent-any" : "pi-subagent-batch",
						waitMode === "any" ? "# First Available Subagent Results" : undefined,
						selectedBatches,
					);
					const pendingText = waited.pending.length > 0
						? `\n\nStill running (${waited.pending.length}):\n${formatList(waited.pending, selectedBatches)}`
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
					return result(`Wait timed out; unfinished subagents are still running:\n${formatList(pending.length > 0 ? pending : records, selectedBatches)}`, {
						agents: records.map(compactRecord),
						batches: selectedBatches.map(compactBatch),
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
			const selected = input?.batch_id ? `batch ${input.batch_id}` : count !== undefined ? "" : input?.input_file ? `manifest ${path.basename(input.input_file)}` : input?.wait_mode === "any" ? "any active" : "";
			const waitMode = input?.wait_mode === "any" || input?.wait_mode === "all" ? input.wait_mode : "";
			const timeout = input?.timeout_seconds ? `· timeout ${formatDuration(input.timeout_seconds * 1_000)}` : "";
			return toolHeader("Wait for subagents", [selected, waitMode ? `· ${waitMode}` : "", timeout].filter(Boolean).join(" "), theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return waitSummaryResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent);
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
				const activeManager = ensureManager(ctx);
				const ids = await resolveIds(params, ctx.cwd, activeManager);
				const records = await activeManager.stop(ids);
				const batchIds = new Set(records.map((record) => record.batchId).filter((id): id is string => Boolean(id)));
				const batches = activeManager.listBatches().filter((batch) => batchIds.has(batch.id));
				return result(`Stop requested:\n${formatList(records, batches)}`, { agents: records.map(compactRecord), batches: batches.map(compactBatch) });
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
		renderCall(args, theme, context) {
			const input = args as any;
			const count = Array.isArray(input?.ids) ? input.ids.length : undefined;
			const detail = input?.batch_id ? `batch ${input.batch_id}` : count !== undefined ? `${count} agent${count === 1 ? "" : "s"}` : input?.input_file ? `manifest ${path.basename(input.input_file)}` : "agents";
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
			const getRecords = () => mergedById(activeManager.list(), hierarchyRecords);
			const getBatches = () => mergedById(activeManager.listBatches(), hierarchyBatches);
			const records = getRecords();
			if (records.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No subagents are known in this parent session.", "info");
				return;
			}
			if (ctx.mode === "rpc") {
				ctx.ui.notify(formatList(records, getBatches()), "info");
				return;
			}
			if (ctx.mode !== "tui") return;
			const isLocal = (id: string) => activeManager.list().some((record) => record.id === id);
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new SubagentDashboard({
					getRecords,
					getBatches,
					tui,
					theme,
					keybindings,
					requestRender: () => tui.requestRender(),
					done: () => done(undefined),
					onSend: async (record) => {
						if (!isLocal(record.id)) throw new Error(`${record.id} is managed by another subagent. Inspect it here, then message it through its parent.`);
						const message = await ctx.ui.editor(`Message ${record.id}`, "");
						if (!message?.trim()) throw new Error("No message was sent.");
						await activeManager.send(record.id, message, "follow_up");
					},
					onStop: async (record) => {
						if (!isLocal(record.id)) throw new Error(`${record.id} is managed by another subagent. Stop it through its parent.`);
						await activeManager.stop([record.id]);
					},
					onShowCommand: async (record) => {
						const command = `pi --session ${JSON.stringify(record.sessionFile)}`;
						await ctx.ui.editor("Native Pi command (copy this; edits are discarded)", command);
						ctx.ui.notify("Stop the managed subagent before opening the same session in another Pi process.", "warning");
					},
				}),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 72, maxHeight: "90%", margin: 1 },
				},
			);
		},
	});

	if (currentAgentId) pi.registerTool({
		name: REPORT_TOOL_NAME,
		label: "Report to Parent",
		description: "Send a mid-task message to this subagent's parent without stopping. The report immediately ends a parent wait that includes this subagent. Use it only for blockers, major issues, and coordination decisions. Use it only when the parent needs information while work continues. Do not use it to report task or work completion. Do not use it for final reports. Pi sends the final answer automatically when this subagent stops.",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, description: "Mid-task message for the parent." }),
			delivery: Type.Optional(StringEnum(PARENT_REPORT_DELIVERIES, { description: "steer delivers after the parent's current tool calls. follow_up waits until the parent finishes its current run. Defaults to follow_up." })),
		}, { additionalProperties: false }),
		async execute(_toolId, params, _signal, _onUpdate, ctx) {
			const message = cleanText(params.message);
			if (!message) throw new Error("message must not be empty");
			const delivery = params.delivery ?? "follow_up";
			ctx.ui.notify(parentReportNotification({ message, delivery }), "info");
			return result(`Sent mid-task message to parent with ${delivery} delivery. Continue the assigned work.`, { delivery });
		},
		renderCall(args, theme, context) {
			const input = args as any;
			return toolHeader("Report to parent", `${input?.delivery ?? "follow_up"} · ${oneLine(input?.message ?? "", 70)}`, theme, context.lastComponent);
		},
		renderResult(resultValue, options, theme, context) {
			return textOrMarkdownResult(resultValue, { ...options, isError: context.isError }, theme, context.lastComponent);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		hierarchyRegistryDir ??= path.join(tmpdir(), "pi-subagent-hierarchy", ctx.sessionManager.getSessionId());
		await mkdir(hierarchyRegistryDir, { recursive: true });
		ensureManager(ctx);
		if (currentAgentId) {
			await publishCurrentHierarchy();
			hierarchyTimer = setInterval(() => void publishCurrentHierarchy(), HIERARCHY_REFRESH_MS);
		} else {
			await refreshHierarchy();
			hierarchyTimer = setInterval(() => void refreshHierarchy(), HIERARCHY_REFRESH_MS);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		if (!flushParentReports("idle")) await flushCompletions();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		pendingParentReports.length = 0;
		parentReportFlushScheduled = false;
		if (hierarchyTimer) clearInterval(hierarchyTimer);
		if (hierarchyPublishTimer) clearTimeout(hierarchyPublishTimer);
		hierarchyTimer = undefined;
		hierarchyPublishTimer = undefined;
		clearWidgetTimers();
		if (latestCtx?.mode === "tui") latestCtx.ui.setWidget(WIDGET_ID, undefined);
		widgetInstalled = false;
		widgetTui = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		const active = manager;
		manager = undefined;
		if (active) await active.dispose();
		if (currentAgentId && hierarchyRegistryDir) {
			try {
				if (active) await publishHierarchySnapshot(hierarchyRegistryDir, currentAgentId, active.list(), active.listBatches());
				else await removeHierarchyReporter(hierarchyRegistryDir, currentAgentId);
			} catch {
				// Hierarchy reporting must not prevent a clean Pi shutdown.
			}
		} else if (hierarchyRegistryDir) {
			await rm(hierarchyRegistryDir, { recursive: true, force: true }).catch(() => {});
			hierarchySnapshotCache.clear();
		}
	});
}
