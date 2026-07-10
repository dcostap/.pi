import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const REVIEW_TOOL_NAME = "launch_review_subagents";
const GENERIC_TOOL_NAME = "launch_generic_subagents";
const MAX_SUBAGENTS = 20;
const REVIEW_SESSION_PREFIX = "[Review Subagent]";
const GENERIC_SESSION_PREFIX = "[Generic Subagent]";
const FINAL_RESULT_DISCLAIMER = "Reminder: Don't blindly trust the subagents' conclusions and statements; be discerning, analytical, and self-reliant. You make your own conclusions.";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MAX_SUBAGENT_ATTEMPTS = 2;
const SUBAGENT_RETRY_DELAY_MS = 1_000;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type SubagentKind = "review" | "generic";

type CommonSubagentParams = {
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
};

type ReviewerParams = CommonSubagentParams & {
	focus?: string;
};

type ReviewLaunchParams = {
	what_to_review: string;
	reviewers: ReviewerParams[];
};

type GenericSubagentParams = CommonSubagentParams & {
	assignment?: string;
};

type GenericLaunchParams = {
	task: string;
	subagents: GenericSubagentParams[];
};

type ResolvedTask = CommonSubagentParams & {
	kind: SubagentKind;
	index: number;
	sessionName: string;
	sandboxDir: string;
	systemPromptPath: string;
	userPrompt: string;
	mainTask: string;
	whatToReview?: string;
	focus?: string;
	assignment?: string;
	modelRef?: string;
	thinking?: ThinkingLevel;
};

type SubagentStatus = "preparing" | "starting" | "running" | "thinking" | "tool" | "done" | "error" | "aborted";

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	latestCacheHitRate?: number;
};

type RuntimeState = {
	kind: SubagentKind;
	index: number;
	description: string;
	sessionName: string;
	sandboxDir: string;
	mainTask: string;
	whatToReview?: string;
	focus?: string;
	assignment?: string;
	modelRef?: string;
	thinking?: ThinkingLevel;
	status: SubagentStatus;
	lastActivity: string;
	finalAnswer: string;
	error?: string;
	sessionFile?: string;
	contextWindow?: number;
	contextTokens?: number;
	contextPercent?: number;
	usage: UsageStats;
	attempt: number;
	maxAttempts: number;
	previousErrors: string[];
	startedAt: number;
	updatedAt: number;
};

type ChildResult = {
	state: RuntimeState;
	exitCode: number | null;
};

function cleanText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function oneLine(value: string, max = 120): string {
	const text = cleanText(value).replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sanitizeDescription(value: string): string {
	const text = cleanText(value).replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ");
	return text.slice(0, 96).trim() || "task";
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/^-+|-+$/g, "");
	return slug || "subagent";
}

function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	const thousands = count / 1000;
	return thousands < 10 ? `${Number(thousands.toFixed(1))}k` : `${Math.round(thousands)}k`;
}

function formatExactTokens(count: number): string {
	return Math.round(count).toLocaleString("en-US");
}

function totalTokens(usage: UsageStats): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0.000000";
	return `$${cost.toFixed(cost < 0.01 ? 6 : 4)}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatUsage(usage: UsageStats): string {
	// Match Pi's footer token convention: show cache read/write only when present,
	// and show CH as the latest response's prompt cache hit rate.
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
		parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
	}
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	return parts.join(" ");
}

function fixedUsage(usage: UsageStats): string {
	return fitColumn(formatUsage(usage), 36);
}

function formatContextUsage(state: RuntimeState): string {
	const contextWindow = state.contextWindow ?? 0;
	if (contextWindow <= 0) return "";
	if (state.contextPercent === undefined) return `?/${formatTokens(contextWindow)}`;
	return `${state.contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
}

function fitColumn(value: string, width: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
	return text.padEnd(width);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("aborted"));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function modelRef(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getSupportedThinkingLevels(model: Model<any>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function formatModelCandidate(model: Model<any>): string {
	const ref = modelRef(model);
	const levels = getSupportedThinkingLevels(model).join(",");
	const label = model.name && model.name !== model.id ? ` (${model.name})` : "";
	return `- ${ref}${label}; thinking: ${levels}`;
}

function parseModelSpec(raw: string): { query: string; thinking?: ThinkingLevel } {
	const trimmed = raw.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1).trim() as ThinkingLevel;
		if ((THINKING_LEVELS as readonly string[]).includes(suffix)) {
			return { query: trimmed.slice(0, colon).trim(), thinking: suffix };
		}
	}
	return { query: trimmed };
}

function uniqueModels(models: Model<any>[]): Model<any>[] {
	const seen = new Set<string>();
	const out: Model<any>[] = [];
	for (const model of models) {
		const ref = modelRef(model).toLowerCase();
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(model);
	}
	return out;
}

function resolveModelOverride(
	query: string,
	availableModels: Model<any>[],
): { ok: true; model: Model<any> } | { ok: false; message: string } {
	const q = query.trim();
	if (!q) return { ok: false, message: "empty model override" };

	const lower = q.toLowerCase();
	const qNorm = normalize(q);
	const ref = (model: Model<any>) => modelRef(model);
	const fields = (model: Model<any>) => [ref(model), model.id, model.name, `${model.provider} ${model.id}`, `${model.provider} ${model.name}`];

	const passes = [
		(model: Model<any>) => ref(model).toLowerCase() === lower,
		(model: Model<any>) => model.id.toLowerCase() === lower,
		(model: Model<any>) => model.name.toLowerCase() === lower,
		(model: Model<any>) => fields(model).some((field) => normalize(field) === qNorm),
		(model: Model<any>) => qNorm.length >= 3 && fields(model).some((field) => normalize(field).includes(qNorm)),
	];

	for (const pass of passes) {
		const matches = uniqueModels(availableModels.filter(pass));
		if (matches.length === 1) return { ok: true, model: matches[0]! };
		if (matches.length > 1) {
			return {
				ok: false,
				message: [`ambiguous model override "${q}" matched ${matches.length} available models:`, ...matches.slice(0, 12).map(formatModelCandidate)].join("\n"),
			};
		}
	}

	return { ok: false, message: `no available model matched override "${q}". Ask the user to clarify, or run \`pi --list-models ${q}\` to inspect available model IDs.` };
}

function getCurrentModelRef(ctx: ExtensionContext): string | undefined {
	return ctx.model ? modelRef(ctx.model as Model<any>) : undefined;
}

function validateRequestedThinking(
	model: Model<any>,
	thinking: ThinkingLevel | undefined,
	explicit: boolean,
): string | undefined {
	if (!thinking || !explicit) return undefined;
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(thinking)) return undefined;
	return `thinking level "${thinking}" is not supported by ${modelRef(model)}. Supported: ${supported.join(", ")}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
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

function buildReviewSubagentInstructions(task: ResolvedTask, cwd: string): string {
	return [
		"You are a Pi code review subagent launched by the main agent.",
		"You are working from the same cwd as the main agent:",
		cwd,
		"",
		"Your scratch sandbox is:",
		task.sandboxDir,
		"",
		"You may freely create, edit, run, and inspect temporary scripts/files inside that sandbox.",
		"Prefer the sandbox for scratch work, experiments, temporary logs, and throwaway scripts.",
		"Do not treat the project cwd itself as scratch space.",
		"Do not make durable project changes. This is code review only.",
		"If you believe a durable project change is necessary, explain that recommendation in your final answer instead of doing it.",
		"",
		"Perform an independent code review of the assigned code review target. Your final assistant answer is the only content that will be returned to the main agent, so make it self-contained and useful.",
	].join("\n");
}

function buildGenericSubagentInstructions(task: ResolvedTask, cwd: string): string {
	return [
		"You are a Pi generic subagent launched by the main agent.",
		"You are working from the same cwd as the main agent:",
		cwd,
		"",
		"Your scratch sandbox is:",
		task.sandboxDir,
		"",
		"Use the sandbox for scratch work, experiments, temporary logs, and throwaway scripts.",
		"Do not treat the project cwd itself as scratch space.",
		"Do not make durable project changes unless the task explicitly asks you to modify project files.",
		"",
		"Complete the assigned task independently. Your final assistant answer is the only content that will be returned to the main agent, so make it self-contained and useful.",
	].join("\n");
}

function buildSubagentInstructionsFile(task: ResolvedTask, cwd: string): string {
	return task.kind === "review" ? buildReviewSubagentInstructions(task, cwd) : buildGenericSubagentInstructions(task, cwd);
}

function buildReviewSubagentUserPrompt(task: ResolvedTask, cwd: string): string {
	const parts = [
		"<persistent_code_review_subagent_instructions>",
		buildReviewSubagentInstructions(task, cwd),
		"</persistent_code_review_subagent_instructions>",
		"",
		"<code_review_rubric>",
		REVIEW_RUBRIC,
		"</code_review_rubric>",
		"",
		"<code_review_target>",
		task.whatToReview ?? task.mainTask,
		"</code_review_target>",
	];
	if (task.focus) {
		parts.push("", "<neutral_focus>", task.focus, "</neutral_focus>");
	}
	parts.push(
		"",
		"Important: follow the code review rubric above. The caller supplied only the code review target and optional neutral focus; do not infer suspected findings from the wording. Report only concrete, actionable code issues you can prove from the code.",
	);
	return parts.join("\n");
}

function buildGenericSubagentUserPrompt(task: ResolvedTask, cwd: string): string {
	const parts = [
		"<persistent_generic_subagent_instructions>",
		buildGenericSubagentInstructions(task, cwd),
		"</persistent_generic_subagent_instructions>",
		"",
		"<task>",
		task.mainTask,
		"</task>",
	];
	if (task.assignment) {
		parts.push("", "<subagent_assignment>", task.assignment, "</subagent_assignment>");
	}
	parts.push("", "Return a concise, self-contained final answer for the main agent to synthesize.");
	return parts.join("\n");
}

function buildMainSystemPromptAddition(): string {
	return [
		"Review subagents:",
		`- You have a ${REVIEW_TOOL_NAME} tool that launches fresh same-cwd Pi code review subagent sessions in parallel.`,
		"- Review subagents are specifically for code reviews. Use them for reviewing code, diffs, implementation plans with code impact, or concrete code-review targets.",
		"- Only launch review subagents when the user explicitly asks for subagents/parallel agents to review code, or unmistakably asks you to delegate code review work to other agents.",
		`- You may launch at most ${MAX_SUBAGENTS} review subagents in one tool call. If the user asks for multiple reviewers, use one parallel tool call rather than sequential calls when possible.`,
		"- The tool already injects the standard code review rubric and output format into each review subagent prompt.",
		"- When calling the review tool, specify only what code to review and optional neutral focus areas. Do not paste review instructions, formatting requirements, expected verdicts, or suspected findings into the review target.",
		"- Avoid biasing review subagents. Do not tell them what bugs you expect unless the user explicitly asked to verify a specific concern; if so, label it as user-provided focus.",
		"- Each review subagent is a brand-new session named `[Review Subagent] <description>`. Choose short, distinctive descriptions; if repeating a similar review, add your own suffix like `#2`.",
		"- The tool returns a final per-subagent stats summary followed by each review subagent's final answer. Synthesize the answers for the user, deduplicate findings, and call out disagreements or uncertainty.",
		"- By default review subagents inherit your current model and thinking level. If the user asks for a different model/thinking, set per-reviewer `model` and/or `thinking`.",
		"- Model overrides may be loose names, but you should resolve ambiguity before launching when possible. If a name could refer to multiple providers/models, ask the user which provider/model they mean instead of guessing. You can inspect models with `pi --list-models <query>` if needed.",
		"",
		"Generic subagents:",
		`- You also have a ${GENERIC_TOOL_NAME} tool that launches fresh same-cwd Pi generic subagent sessions in parallel.`,
		"- Generic subagents do not receive the code review rubric or any task-specific output format. Provide the complete task and any per-subagent assignment yourself.",
		"- Use generic subagents only when the user explicitly asks for subagents/parallel agents/delegation, or unmistakably wants independent parallel investigation or exploration.",
		"- Do not use generic subagents for code review tasks; use the review subagent tool for code reviews.",
		`- You may launch at most ${MAX_SUBAGENTS} generic subagents in one tool call.`,
		"- Each generic subagent is a brand-new session named `[Generic Subagent] <description>`. Choose short, distinctive descriptions.",
		"- The generic tool returns a final per-subagent stats summary followed by each subagent's final answer. Synthesize results for the user, deduplicate, and call out disagreements or uncertainty.",
		"- By default generic subagents inherit your current model and thinking level. If the user asks for a different model/thinking, set per-subagent `model` and/or `thinking`.",
		"- Generic subagent model overrides follow the same ambiguity rules as review subagents: ask the user to clarify rather than guessing among multiple possible model matches.",
	].join("\n");
}

function assistantTextFromMessage(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return cleanText(content);
	if (!Array.isArray(content)) return "";
	return cleanText(
		content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n"),
	);
}

function finalAssistantText(messages: any[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = assistantTextFromMessage(message);
		if (text) return text;
	}
	return "";
}

function updateUsageFromMessage(state: RuntimeState, message: any): void {
	const usage = message?.usage;
	if (!usage) return;
	const input = Number(usage.input || 0);
	const output = Number(usage.output || 0);
	const cacheRead = Number(usage.cacheRead || 0);
	const cacheWrite = Number(usage.cacheWrite || 0);
	state.usage.input += input;
	state.usage.output += output;
	state.usage.cacheRead += cacheRead;
	state.usage.cacheWrite += cacheWrite;
	state.usage.cost += Number(usage.cost?.total || 0);
	state.usage.turns++;
	const latestPromptTokens = input + cacheRead + cacheWrite;
	state.usage.latestCacheHitRate = latestPromptTokens > 0 ? (cacheRead / latestPromptTokens) * 100 : undefined;

	const contextTokens = Number(usage.totalTokens || input + output + cacheRead + cacheWrite);
	if (contextTokens > 0) {
		state.contextTokens = contextTokens;
		if ((state.contextWindow ?? 0) > 0) state.contextPercent = (contextTokens / state.contextWindow!) * 100;
	}
}

function formatToolActivity(toolName: string, args: any): string {
	if (toolName === "bash") return `$ ${oneLine(String(args?.command ?? "..."), 90)}`;
	if (toolName === "read") return `read ${oneLine(String(args?.path ?? args?.file_path ?? "..."), 90)}`;
	if (toolName === "edit") return `edit ${oneLine(String(args?.path ?? args?.file_path ?? "..."), 90)}`;
	if (toolName === "write") return `write ${oneLine(String(args?.path ?? args?.file_path ?? "..."), 90)}`;
	if (toolName === "grep") return `grep ${oneLine(String(args?.pattern ?? ""), 60)}`;
	if (toolName === "find") return `find ${oneLine(String(args?.pattern ?? "*"), 60)}`;
	if (toolName === "ls") return `ls ${oneLine(String(args?.path ?? "."), 90)}`;
	return `${toolName} ${oneLine(JSON.stringify(args ?? {}), 90)}`;
}

function statusIcon(status: SubagentStatus): string {
	switch (status) {
		case "done": return "✓";
		case "error": return "✗";
		case "aborted": return "■";
		case "thinking": return "◌";
		case "tool": return "↦";
		case "running": return "…";
		case "starting": return "◐";
		default: return "·";
	}
}

function buildSubagentPromptHeader(states: RuntimeState[]): string {
	const first = states[0];
	const mainTask = states.find((state) => state.mainTask)?.mainTask;
	const lines: string[] = [];
	if (mainTask) {
		lines.push(first?.kind === "generic" ? "Generic task prompt sent to subagents:" : "Code review target prompt sent to subagents:", "<<<", mainTask, ">>>");
	}
	const detailLines = states
		.map((state) => {
			if (state.kind === "generic" && state.assignment) return `- ${state.sessionName}: ${state.assignment}`;
			if (state.kind === "review" && state.focus) return `- ${state.sessionName}: ${state.focus}`;
			return undefined;
		})
		.filter((line): line is string => Boolean(line));
	if (detailLines.length > 0) lines.push("", first?.kind === "generic" ? "Assignment by subagent:" : "Neutral focus by subagent:", ...detailLines);
	return lines.join("\n");
}

function buildToolPartial(states: RuntimeState[]) {
	const lines = states.map((state) => {
		const status = fitColumn(`${statusIcon(state.status)} ${state.status}`, 12);
		const usage = fixedUsage(state.usage);
		const name = fitColumn(state.sessionName, 56);
		const context = fitColumn(formatContextUsage(state), 14);
		const attempt = state.maxAttempts > 1 && state.attempt > 1 ? ` attempt=${state.attempt}/${state.maxAttempts}` : "";
		const model = `model=${state.modelRef ?? "(unknown)"} [${state.thinking ?? "(unknown)"}]${attempt}`;
		const activity = state.error ?? state.lastActivity;
		return `${status} ${usage} ${context} ${model} ${name} ${activity}`;
	});
	const header = buildSubagentPromptHeader(states);
	const text = [header, lines.join("\n")].filter(Boolean).join("\n\n") || "subagents preparing...";
	return {
		content: [{ type: "text" as const, text }],
		details: { states },
	};
}

class RpcClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private nextId = 0;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
	stderr = "";

	constructor(
		private readonly task: ResolvedTask,
		private readonly cwd: string,
		private readonly state: RuntimeState,
		private readonly onEvent: (event: any) => void,
	) {}

	start(signal?: AbortSignal): void {
		const args = ["--mode", "rpc", "--name", this.task.sessionName];
		if (this.state.attempt > 1 && this.state.sessionFile) args.push("--session", this.state.sessionFile);
		if (this.task.modelRef) args.push("--model", this.task.modelRef);
		if (this.task.thinking) args.push("--thinking", this.task.thinking);

		const invocation = getPiInvocation(args);
		this.child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_SANDBOX: this.task.sandboxDir,
			},
		});

		const abort = () => this.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		this.child.once("close", () => signal?.removeEventListener("abort", abort));

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
		});

		this.child.on("error", (error) => {
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		});
	}

	waitForExit(): Promise<number | null> {
		return new Promise((resolve) => {
			if (!this.child) return resolve(null);
			this.child.once("close", (code) => {
				if (this.buffer.trim()) this.handleLine(this.buffer.trim());
				for (const pending of this.pending.values()) pending.reject(new Error(`subagent exited with code ${code ?? "unknown"}`));
				this.pending.clear();
				resolve(code);
			});
		});
	}

	async send(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
		if (!this.child?.stdin) throw new Error("subagent process is not running");
		const id = `subagent-${this.task.index}-${this.nextId++}`;
		const command = { id, type, ...payload };
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timed out waiting for ${type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.child?.stdin.write(`${JSON.stringify(command)}\n`);
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			this.child?.kill(signal);
		} catch {}
	}

	private handleLine(line: string): void {
		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}

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
}

function rpcModelRef(model: any): string | undefined {
	if (model && typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
	return undefined;
}

function applyRpcStateMetadata(state: RuntimeState, data: any): void {
	if (!data) return;
	if (typeof data.sessionFile === "string") state.sessionFile = data.sessionFile;
	const actualModelRef = rpcModelRef(data.model);
	if (actualModelRef) state.modelRef = actualModelRef;
	if (typeof data.model?.contextWindow === "number") state.contextWindow = data.model.contextWindow;
	if ((THINKING_LEVELS as readonly string[]).includes(data.thinkingLevel)) state.thinking = data.thinkingLevel;
}

function applyEventToState(state: RuntimeState, event: any): void {
	state.updatedAt = Date.now();
	if (event.type === "agent_start") {
		state.status = "running";
		state.lastActivity = "started";
		return;
	}
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type === "thinking_start" || update?.type === "thinking_delta") {
			state.status = "thinking";
			state.lastActivity = "thinking…";
		} else if (update?.type === "text_delta") {
			state.status = "running";
			state.lastActivity = "providing final answer…";
		} else if (update?.type === "toolcall_end" && update.toolCall) {
			state.status = "tool";
			state.lastActivity = formatToolActivity(update.toolCall.name, update.toolCall.arguments);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		state.status = "tool";
		state.lastActivity = formatToolActivity(event.toolName, event.args);
		return;
	}
	if (event.type === "tool_execution_update") {
		state.status = "tool";
		state.lastActivity = event.toolName ? `${event.toolName} running…` : "tool running…";
		return;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		updateUsageFromMessage(state, event.message);
		const text = assistantTextFromMessage(event.message);
		if (text) state.finalAnswer = text;
		if (event.message.stopReason === "error" || event.message.errorMessage) {
			state.status = "error";
			state.error = event.message.errorMessage || "assistant response ended with an error";
			state.lastActivity = "failed";
		}
		return;
	}
	if (event.type === "agent_end") {
		const text = finalAssistantText(event.messages || []);
		if (state.status === "error" || state.status === "aborted") {
			if (text && !state.finalAnswer) state.finalAnswer = text;
			return;
		}
		if (text) {
			state.finalAnswer = text;
			state.status = "done";
			state.lastActivity = "finished";
		} else {
			state.status = "done";
			state.lastActivity = "finished without final answer";
		}
	}
}

type PendingResolvedTask = Omit<ResolvedTask, "sandboxDir" | "systemPromptPath" | "userPrompt">;

type PreparedTasks = { tasks?: ResolvedTask[]; errors?: string[] };

function resolveCommonSubagentParams(
	params: CommonSubagentParams,
	index: number,
	label: string,
	errors: string[],
	availableModels: Model<any>[],
	currentModelRef: string | undefined,
	currentThinking: ThinkingLevel,
): CommonSubagentParams & { description: string; modelRef?: string; thinking?: ThinkingLevel } {
	const description = sanitizeDescription(params.description || "");
	if (!description) errors.push(`${label} ${index + 1}: description is required`);

	let modelOverride = params.model?.trim();
	let thinking = params.thinking ?? currentThinking;
	let explicitThinking = Boolean(params.thinking);
	let modelRefForTask = currentModelRef;

	if (modelOverride) {
		const parsed = parseModelSpec(modelOverride);
		modelOverride = parsed.query;
		if (parsed.thinking) {
			if (params.thinking && params.thinking !== parsed.thinking) {
				errors.push(`${label} ${index + 1}: model override includes :${parsed.thinking} but thinking is also set to ${params.thinking}`);
			} else {
				thinking = parsed.thinking;
				explicitThinking = true;
			}
		}

		const match = resolveModelOverride(modelOverride, availableModels);
		if (match.ok === false) {
			errors.push(`${label} ${index + 1} (${description}): ${match.message}`);
		} else {
			modelRefForTask = modelRef(match.model);
			const thinkingError = validateRequestedThinking(match.model, thinking, explicitThinking);
			if (thinkingError) errors.push(`${label} ${index + 1} (${description}): ${thinkingError}`);
		}
	}

	return {
		...params,
		description,
		modelRef: modelRefForTask,
		thinking,
	};
}

async function finalizeTasks(
	pending: PendingResolvedTask[],
	ctx: ExtensionContext,
	systemPromptFileName: string,
	buildUserPrompt: (task: ResolvedTask, cwd: string) => string,
): Promise<ResolvedTask[]> {
	const withSandboxes: ResolvedTask[] = [];
	for (const task of pending) {
		const sandboxRoot = path.join(tmpdir(), "pi-subagents");
		await mkdir(sandboxRoot, { recursive: true });
		const unique = `${slugify(task.description)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
		const sandboxDir = path.join(sandboxRoot, unique);
		await mkdir(sandboxDir, { recursive: true });
		const systemPromptPath = path.join(sandboxDir, systemPromptFileName);
		const finalTask: ResolvedTask = { ...task, sandboxDir, systemPromptPath, userPrompt: "" };
		finalTask.userPrompt = buildUserPrompt(finalTask, ctx.cwd);
		await writeFile(systemPromptPath, buildSubagentInstructionsFile(finalTask, ctx.cwd), "utf8");
		withSandboxes.push(finalTask);
	}
	return withSandboxes;
}

async function prepareReviewTasks(params: ReviewLaunchParams, ctx: ExtensionContext, pi: ExtensionAPI): Promise<PreparedTasks> {
	const errors: string[] = [];
	const whatToReview = cleanText(params.what_to_review || "");
	if (!whatToReview) errors.push("what_to_review is required and should describe only the code review target");
	if (!Array.isArray(params.reviewers) || params.reviewers.length === 0) errors.push("reviewers must contain at least one code review subagent");
	if (Array.isArray(params.reviewers) && params.reviewers.length > MAX_SUBAGENTS) errors.push(`at most ${MAX_SUBAGENTS} code review subagents may be launched at once`);
	if (errors.length > 0) return { errors };

	const availableModels = ctx.modelRegistry.getAvailable() as Model<any>[];
	const currentModelRef = getCurrentModelRef(ctx);
	const currentThinking = pi.getThinkingLevel() as ThinkingLevel;
	const resolved: PendingResolvedTask[] = [];

	params.reviewers.forEach((reviewer, index) => {
		const common = resolveCommonSubagentParams(reviewer, index, "reviewer", errors, availableModels, currentModelRef, currentThinking);
		const focus = cleanText(reviewer.focus || "");
		resolved.push({
			...common,
			kind: "review",
			index,
			sessionName: `${REVIEW_SESSION_PREFIX} ${common.description}`,
			mainTask: whatToReview,
			whatToReview,
			focus: focus || undefined,
		});
	});

	if (errors.length > 0) return { errors };
	return { tasks: await finalizeTasks(resolved, ctx, "REVIEW_SUBAGENT_SYSTEM_PROMPT.md", buildReviewSubagentUserPrompt) };
}

async function prepareGenericTasks(params: GenericLaunchParams, ctx: ExtensionContext, pi: ExtensionAPI): Promise<PreparedTasks> {
	const errors: string[] = [];
	const task = cleanText(params.task || "");
	if (!task) errors.push("task is required and should contain the full generic subagent task");
	if (!Array.isArray(params.subagents) || params.subagents.length === 0) errors.push("subagents must contain at least one generic subagent");
	if (Array.isArray(params.subagents) && params.subagents.length > MAX_SUBAGENTS) errors.push(`at most ${MAX_SUBAGENTS} generic subagents may be launched at once`);
	if (errors.length > 0) return { errors };

	const availableModels = ctx.modelRegistry.getAvailable() as Model<any>[];
	const currentModelRef = getCurrentModelRef(ctx);
	const currentThinking = pi.getThinkingLevel() as ThinkingLevel;
	const resolved: PendingResolvedTask[] = [];

	params.subagents.forEach((subagent, index) => {
		const common = resolveCommonSubagentParams(subagent, index, "subagent", errors, availableModels, currentModelRef, currentThinking);
		const assignment = cleanText(subagent.assignment || "");
		resolved.push({
			...common,
			kind: "generic",
			index,
			sessionName: `${GENERIC_SESSION_PREFIX} ${common.description}`,
			mainTask: task,
			assignment: assignment || undefined,
		});
	});

	if (errors.length > 0) return { errors };
	return { tasks: await finalizeTasks(resolved, ctx, "GENERIC_SUBAGENT_SYSTEM_PROMPT.md", buildGenericSubagentUserPrompt) };
}

function buildSubagentRetryPrompt(task: ResolvedTask, state: RuntimeState): string {
	const reason = state.previousErrors.at(-1) ?? state.error ?? "the previous subagent attempt failed before completing";
	return [
		"The previous attempt for this subagent appears to have failed due to a transient/runtime error.",
		`Failure note: ${reason}`,
		"",
		"You are being resumed in the same subagent session. Continue the assigned work from the existing conversation and any scratch files in your sandbox.",
		"Do not start over unless the prior context is unusable. If needed, briefly inspect relevant files/state, then finish the original assignment.",
		"",
		`Original assignment summary: ${task.assignment || task.focus || task.whatToReview || task.mainTask}`,
	].join("\n");
}

async function runSubagent(task: ResolvedTask, ctx: ExtensionContext, state: RuntimeState, emit: () => void, signal?: AbortSignal): Promise<ChildResult> {
	state.status = "starting";
	state.lastActivity = state.attempt > 1 ? `starting retry attempt ${state.attempt}/${state.maxAttempts}…` : "starting pi rpc session…";
	emit();

	let client: RpcClient | null = null;

	try {
		let sawAgentEnd = false;
		let resolveDone!: () => void;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		client = new RpcClient(task, ctx.cwd, state, (event) => {
			applyEventToState(state, event);
			if (event.type === "agent_end") {
				sawAgentEnd = true;
				resolveDone();
			}
			emit();
		});

		client.start(signal);
		const exitPromise = client.waitForExit();
		const prompt = state.attempt > 1 && state.sessionFile ? buildSubagentRetryPrompt(task, state) : task.userPrompt;
		await client.send("prompt", { message: prompt }, 30_000);
		try {
			const stateResponse = await client.send("get_state", {}, 5_000);
			applyRpcStateMetadata(state, stateResponse.data);
			emit();
		} catch {
			// Session path and actual selected model are nice-to-have only.
		}

		const completed = await Promise.race([donePromise.then(() => "done" as const), exitPromise.then(() => "exit" as const)]);
		if (completed === "done") {
			client.kill("SIGTERM");
			const forceKill = setTimeout(() => client?.kill("SIGKILL"), 2_000);
			forceKill.unref?.();
			const exitCode = await exitPromise;
			clearTimeout(forceKill);
			if (signal?.aborted) {
				state.status = "aborted";
				state.error = "aborted by user";
				state.lastActivity = "aborted";
			} else if (!sawAgentEnd && (state.status as SubagentStatus) !== "done") {
				state.status = "error";
				state.error = "subagent exited before agent_end";
				state.lastActivity = "failed";
			}
			emit();
			return { state, exitCode };
		}

		const exitCode = await exitPromise;
		if (signal?.aborted) {
			state.status = "aborted";
			state.error = "aborted by user";
			state.lastActivity = "aborted";
		} else if ((state.status as SubagentStatus) !== "done") {
			state.status = "error";
			state.error = client.stderr.trim() || `subagent exited before completion with code ${exitCode ?? "unknown"}`;
			state.lastActivity = "failed";
		}
		if (!state.finalAnswer && client.stderr.trim() && state.status === "error") state.finalAnswer = client.stderr.trim();
		emit();
		return { state, exitCode };
	} catch (error) {
		client?.kill("SIGTERM");
		state.status = signal?.aborted ? "aborted" : "error";
		state.error = error instanceof Error ? error.message : String(error);
		state.lastActivity = state.status;
		emit();
		return { state, exitCode: null };
	}
}

function retryReason(state: RuntimeState): string {
	const parts = [state.error, state.finalAnswer].filter(Boolean);
	return cleanText(parts.join("\n")) || (state.status === "done" ? "subagent finished without a final answer" : `subagent ended with status ${state.status}`);
}

function isLikelyTransientSubagentFailure(result: ChildResult, signal?: AbortSignal): boolean {
	const state = result.state;
	if (signal?.aborted || state.status === "aborted") return false;
	if (state.status === "done") return !state.finalAnswer.trim();
	if (state.status !== "error") return false;

	const reason = retryReason(state);
	return /WebSocket closed|provider_transport_failure|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|terminated|stream closed|connection closed|timed out/i.test(reason);
}

async function runSubagentWithRetries(task: ResolvedTask, ctx: ExtensionContext, state: RuntimeState, emit: () => void, signal?: AbortSignal): Promise<ChildResult> {
	let lastResult: ChildResult | undefined;
	for (let attempt = 1; attempt <= state.maxAttempts; attempt++) {
		state.attempt = attempt;
		state.error = undefined;
		state.finalAnswer = "";
		lastResult = await runSubagent(task, ctx, state, emit, signal);
		const retryable = isLikelyTransientSubagentFailure(lastResult, signal);
		if (attempt >= state.maxAttempts || !retryable) {
			if (!state.finalAnswer.trim() && state.status === "done") {
				state.status = "error";
				state.error = retryReason(state);
				state.lastActivity = "failed";
				emit();
			}
			return lastResult;
		}

		const reason = retryReason(state);
		state.previousErrors.push(`attempt ${attempt}: ${reason}`);
		state.status = "starting";
		state.error = undefined;
		state.lastActivity = `retrying after ${oneLine(reason, 90)}`;
		state.updatedAt = Date.now();
		emit();
		try {
			await delay(SUBAGENT_RETRY_DELAY_MS, signal);
		} catch {
			state.status = "aborted";
			state.error = "aborted by user";
			state.lastActivity = "aborted";
			emit();
			return { state, exitCode: lastResult.exitCode };
		}
	}
	return lastResult ?? { state, exitCode: null };
}

function sumUsage(states: RuntimeState[]): UsageStats {
	return states.reduce<UsageStats>((total, state) => ({
		input: total.input + state.usage.input,
		output: total.output + state.usage.output,
		cacheRead: total.cacheRead + state.usage.cacheRead,
		cacheWrite: total.cacheWrite + state.usage.cacheWrite,
		cost: total.cost + state.usage.cost,
		turns: total.turns + state.usage.turns,
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
}

function buildFinalStats(states: RuntimeState[]): { text: string; summary: Record<string, unknown> } {
	const usage = sumUsage(states);
	const statusCounts = states.reduce<Record<string, number>>((counts, state) => {
		counts[state.status] = (counts[state.status] ?? 0) + 1;
		return counts;
	}, {});
	const attempts = states.reduce((total, state) => total + state.attempt, 0);
	const earliestStart = states.length > 0 ? Math.min(...states.map((state) => state.startedAt)) : 0;
	const latestFinish = states.length > 0 ? Math.max(...states.map((state) => state.updatedAt)) : earliestStart;
	const wallDurationMs = Math.max(0, latestFinish - earliestStart);
	const combinedAgentDurationMs = states.reduce((total, state) => total + Math.max(0, state.updatedAt - state.startedAt), 0);
	const statusText = Object.entries(statusCounts).map(([status, count]) => `${count} ${status}`).join(", ") || "none";

	const overall = [
		"# Final Subagent Stats",
		"",
		"## Overall",
		`- **Subagents:** ${states.length} (${statusText})`,
		`- **Attempts / model turns:** ${countLabel(attempts, "attempt")} · ${countLabel(usage.turns, "turn")}`,
		`- **Time:** ${formatDuration(wallDurationMs)} wall · ${formatDuration(combinedAgentDurationMs)} combined agent time`,
		`- **Tokens:** ${formatExactTokens(totalTokens(usage))} total (input ${formatExactTokens(usage.input)} · output ${formatExactTokens(usage.output)} · cache read ${formatExactTokens(usage.cacheRead)} · cache write ${formatExactTokens(usage.cacheWrite)})`,
		`- **Total cost:** ${formatCost(usage.cost)}`,
		"",
		"## Per Subagent",
	];

	const perSubagent = states.flatMap((state, index) => {
		const context = formatContextUsage(state) || "unknown";
		const cacheHit = state.usage.latestCacheHitRate === undefined ? "unknown" : `${state.usage.latestCacheHitRate.toFixed(1)}%`;
		const lines = [
			`### ${index + 1}. ${state.sessionName}`,
			`- **Status:** ${state.status}${state.error ? ` — ${oneLine(state.error, 180)}` : ""}`,
			`- **Model:** ${state.modelRef ?? "unknown"} · thinking ${state.thinking ?? "unknown"}`,
			`- **Attempts / model turns:** ${countLabel(state.attempt, "attempt")} · ${countLabel(state.usage.turns, "turn")} · **duration:** ${formatDuration(state.updatedAt - state.startedAt)}`,
			`- **Tokens:** ${formatExactTokens(totalTokens(state.usage))} total (input ${formatExactTokens(state.usage.input)} · output ${formatExactTokens(state.usage.output)} · cache read ${formatExactTokens(state.usage.cacheRead)} · cache write ${formatExactTokens(state.usage.cacheWrite)})`,
			`- **Cost:** ${formatCost(state.usage.cost)} · **latest cache hit:** ${cacheHit} · **final context:** ${context}`,
			`- **Session:** ${state.sessionFile ?? "unavailable"}`,
		];
		if (state.previousErrors.length > 0) {
			lines.push("- **Retry history:**", ...state.previousErrors.map((error) => `  - ${oneLine(error, 180)}`));
		}
		return [...lines, ""];
	});

	return {
		text: [...overall, ...perSubagent].join("\n").trim(),
		summary: {
			count: states.length,
			statusCounts,
			attempts,
			wallDurationMs,
			combinedAgentDurationMs,
			usage: { ...usage, totalTokens: totalTokens(usage) },
		},
	};
}

function buildFinalToolResult(results: ChildResult[]) {
	const states = results.map((result) => result.state);
	const stats = buildFinalStats(states);
	const answers = results.map(({ state }, index) => {
		const title = `## Answer ${index + 1} — ${state.sessionName}`;
		const metadata = `> **${state.status}** · ${state.modelRef ?? "unknown"} · thinking ${state.thinking ?? "unknown"}`;
		const body = state.finalAnswer || state.error || (state.status === "done" ? "(Subagent finished without a final answer.)" : "Subagent failed without a final answer.");
		return `---\n\n${title}\n\n${metadata}\n\n${body}`;
	});
	const failures = results.filter((result) => result.state.status === "error" || result.state.status === "aborted").length;
	const header = buildSubagentPromptHeader(states);
	const assignmentContext = header ? `# Assignment Context\n\n${header}` : "";
	const priorityLegend = results[0]?.state.kind === "review"
		? "Priority legend: [P0] critical/blocking, [P1] high/should fix before merge/use, [P2] medium/actionable, [P3] low/minor or test gap."
		: "";
	const answersSection = ["# Subagent Answers", priorityLegend, ...answers].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text: [stats.text, assignmentContext, answersSection, "---", FINAL_RESULT_DISCLAIMER].filter(Boolean).join("\n\n") }],
		details: {
			failures,
			summary: stats.summary,
			results: results.map((result) => ({
				kind: result.state.kind,
				description: result.state.description,
				sessionName: result.state.sessionName,
				sessionFile: result.state.sessionFile,
				sandboxDir: result.state.sandboxDir,
				mainTask: result.state.mainTask,
				whatToReview: result.state.whatToReview,
				focus: result.state.focus,
				assignment: result.state.assignment,
				status: result.state.status,
				modelRef: result.state.modelRef,
				thinking: result.state.thinking,
				error: result.state.error,
				usage: { ...result.state.usage, totalTokens: totalTokens(result.state.usage) },
				durationMs: Math.max(0, result.state.updatedAt - result.state.startedAt),
				contextWindow: result.state.contextWindow,
				contextTokens: result.state.contextTokens,
				contextPercent: result.state.contextPercent,
				attempts: result.state.attempt,
				previousErrors: result.state.previousErrors,
			})),
		},
		isError: failures === results.length,
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildMainSystemPromptAddition()}`,
	}));

	pi.registerTool({
		name: REVIEW_TOOL_NAME,
		label: "Launch Code Review Subagents",
		description: `Launch 1-${MAX_SUBAGENTS} fresh same-cwd Pi code review subagents in parallel. The extension injects the code review rubric and output format; callers should provide only what code to review and optional neutral focus areas.`,
		parameters: Type.Object({
			what_to_review: Type.String({ description: "Neutral description of the code review target. Specify only what code to review; do not include review rubric, output formatting, suspected findings, or expected verdict." }),
			reviewers: Type.Array(
				Type.Object({
					description: Type.String({ description: "Short session description used as `[Review Subagent] <description>`. Make it distinctive; add #2 etc yourself for repeated reviewers." }),
					focus: Type.Optional(Type.String({ description: "Optional neutral focus area, such as 'data safety' or 'performance'. Do not include suspected findings unless the user explicitly asked to verify them." })),
					model: Type.Optional(Type.String({ description: "Optional model override. Prefer explicit provider/model-id when known; loose names are accepted only if they match one available model." })),
					thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)) as any, { description: "Optional Pi thinking level override." })),
				}),
				{ minItems: 1, maxItems: MAX_SUBAGENTS, description: `Code review subagents to launch in parallel, max ${MAX_SUBAGENTS}.` },
			),
		}),
		async execute(_toolCallId, params: ReviewLaunchParams, signal, onUpdate, ctx) {
			const prepared: PreparedTasks = await prepareReviewTasks(params, ctx, pi).catch((error) => ({ errors: [error instanceof Error ? error.message : String(error)] }));
			if (prepared.errors?.length) {
				return {
					content: [{ type: "text", text: [`Code review subagents were not launched because validation failed:`, ...prepared.errors.map((error) => `- ${error}`)].join("\n") }],
					details: { errors: prepared.errors },
					isError: true,
				};
			}

			const tasks = prepared.tasks ?? [];
			const activeStates: RuntimeState[] = tasks.map((task) => ({
				kind: task.kind,
				index: task.index,
				description: task.description,
				sessionName: task.sessionName,
				sandboxDir: task.sandboxDir,
				mainTask: task.mainTask,
				whatToReview: task.whatToReview,
				focus: task.focus,
				assignment: task.assignment,
				modelRef: task.modelRef,
				thinking: task.thinking,
				status: "preparing",
				lastActivity: "prepared",
				finalAnswer: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				attempt: 1,
				maxAttempts: MAX_SUBAGENT_ATTEMPTS,
				previousErrors: [],
				startedAt: Date.now(),
				updatedAt: Date.now(),
			}));

			const emit = () => {
				onUpdate?.(buildToolPartial(activeStates));
			};

			emit();

			if (signal?.aborted) {
				for (const state of activeStates) {
					state.status = "aborted";
					state.error = "aborted before launch";
				}
				return buildFinalToolResult(activeStates.map((state) => ({ state, exitCode: null })));
			}

			const results = await Promise.all(tasks.map((task, index) => runSubagentWithRetries(task, ctx, activeStates[index]!, emit, signal)));
			emit();
			return buildFinalToolResult(results);
		},
		renderCall(args, theme) {
			const count = Array.isArray((args as any)?.reviewers) ? (args as any).reviewers.length : 0;
			const label = `${theme.fg("toolTitle", theme.bold(REVIEW_TOOL_NAME))} ${theme.fg("accent", `${count} reviewer${count === 1 ? "" : "s"}`)}`;
			return new Text(label, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const text = result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
			const prefix = result?.isError ? theme.fg("error", "code review subagents") : theme.fg("success", "code review subagents");
			if (isPartial) return new Text(`${prefix}\n\n${text}`, 0, 0);

			const container = new Container();
			container.addChild(new Text(prefix, 0, 0));
			if (text) container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
			return container;
		},
	});

	pi.registerTool({
		name: GENERIC_TOOL_NAME,
		label: "Launch Generic Subagents",
		description: `Launch 1-${MAX_SUBAGENTS} fresh same-cwd Pi generic subagents in parallel. No code review rubric or task-specific output format is injected; callers must provide the complete task and any per-subagent assignment.`,
		parameters: Type.Object({
			task: Type.String({ description: "Complete generic task to give every subagent. Include all relevant context and desired output shape." }),
			subagents: Type.Array(
				Type.Object({
					description: Type.String({ description: "Short session description used as `[Generic Subagent] <description>`. Make it distinctive; add #2 etc yourself for repeated subagents." }),
					assignment: Type.Optional(Type.String({ description: "Optional per-subagent assignment, angle, or scope. This is appended to the shared task." })),
					model: Type.Optional(Type.String({ description: "Optional model override. Prefer explicit provider/model-id when known; loose names are accepted only if they match one available model." })),
					thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)) as any, { description: "Optional Pi thinking level override." })),
				}),
				{ minItems: 1, maxItems: MAX_SUBAGENTS, description: `Generic subagents to launch in parallel, max ${MAX_SUBAGENTS}.` },
			),
		}),
		async execute(_toolCallId, params: GenericLaunchParams, signal, onUpdate, ctx) {
			const prepared: PreparedTasks = await prepareGenericTasks(params, ctx, pi).catch((error) => ({ errors: [error instanceof Error ? error.message : String(error)] }));
			if (prepared.errors?.length) {
				return {
					content: [{ type: "text", text: [`Generic subagents were not launched because validation failed:`, ...prepared.errors.map((error) => `- ${error}`)].join("\n") }],
					details: { errors: prepared.errors },
					isError: true,
				};
			}

			const tasks = prepared.tasks ?? [];
			const activeStates: RuntimeState[] = tasks.map((task) => ({
				kind: task.kind,
				index: task.index,
				description: task.description,
				sessionName: task.sessionName,
				sandboxDir: task.sandboxDir,
				mainTask: task.mainTask,
				whatToReview: task.whatToReview,
				focus: task.focus,
				assignment: task.assignment,
				modelRef: task.modelRef,
				thinking: task.thinking,
				status: "preparing",
				lastActivity: "prepared",
				finalAnswer: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				attempt: 1,
				maxAttempts: MAX_SUBAGENT_ATTEMPTS,
				previousErrors: [],
				startedAt: Date.now(),
				updatedAt: Date.now(),
			}));

			const emit = () => {
				onUpdate?.(buildToolPartial(activeStates));
			};

			emit();

			if (signal?.aborted) {
				for (const state of activeStates) {
					state.status = "aborted";
					state.error = "aborted before launch";
				}
				return buildFinalToolResult(activeStates.map((state) => ({ state, exitCode: null })));
			}

			const results = await Promise.all(tasks.map((task, index) => runSubagentWithRetries(task, ctx, activeStates[index]!, emit, signal)));
			emit();
			return buildFinalToolResult(results);
		},
		renderCall(args, theme) {
			const count = Array.isArray((args as any)?.subagents) ? (args as any).subagents.length : 0;
			const label = `${theme.fg("toolTitle", theme.bold(GENERIC_TOOL_NAME))} ${theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)}`;
			return new Text(label, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const text = result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
			const prefix = result?.isError ? theme.fg("error", "generic subagents") : theme.fg("success", "generic subagents");
			if (isPartial) return new Text(`${prefix}\n\n${text}`, 0, 0);

			const container = new Container();
			container.addChild(new Text(prefix, 0, 0));
			if (text) container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
			return container;
		},
	});
}
