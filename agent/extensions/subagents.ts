import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "launch_review_subagents";
const MAX_SUBAGENTS = 4;
const SESSION_PREFIX = "[Review Subagent]";
const FINAL_RESULT_DISCLAIMER = "Reminder: Don't blindly trust the subagents' conclusions and statements; be discerning, analytical, and self-reliant. You make your own conclusions.";
const WORKER_ENV = "PI_SUBAGENT_ROLE";
const WORKER_ENV_VALUE = "worker";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type ReviewerParams = {
	description: string;
	focus?: string;
	model?: string;
	thinking?: ThinkingLevel;
};

type LaunchParams = {
	what_to_review: string;
	reviewers: ReviewerParams[];
};

type ResolvedTask = ReviewerParams & {
	index: number;
	sessionName: string;
	sandboxDir: string;
	systemPromptPath: string;
	whatToReview: string;
	focus?: string;
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
};

type RuntimeState = {
	index: number;
	description: string;
	sessionName: string;
	sandboxDir: string;
	modelRef?: string;
	thinking?: ThinkingLevel;
	status: SubagentStatus;
	lastActivity: string;
	finalAnswer: string;
	error?: string;
	sessionFile?: string;
	usage: UsageStats;
	startedAt: number;
	updatedAt: number;
};

type ChildResult = {
	state: RuntimeState;
	exitCode: number | null;
};

function isWorker(): boolean {
	return process.env[WORKER_ENV] === WORKER_ENV_VALUE;
}

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

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function fixedUsage(usage: UsageStats): string {
	return [
		`↑${formatTokens(usage.input).padEnd(5)}`,
		`↓${formatTokens(usage.output).padEnd(5)}`,
		`R${formatTokens(usage.cacheRead).padEnd(5)}`,
		`W${formatTokens(usage.cacheWrite).padEnd(5)}`,
		`$${usage.cost.toFixed(4).padEnd(8)}`,
	].join(" ");
}

function fitColumn(value: string, width: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
	return text.padEnd(width);
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

You are acting as an independent code reviewer. The caller will provide the review target separately.

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

function buildSubagentInstructions(task: ResolvedTask, cwd: string): string {
	return [
		"You are a Pi review subagent launched by the main agent.",
		"You are working from the same cwd as the main agent:",
		cwd,
		"",
		"Your scratch sandbox is:",
		task.sandboxDir,
		"",
		"You may freely create, edit, run, and inspect temporary scripts/files inside that sandbox.",
		"Prefer the sandbox for scratch work, experiments, temporary logs, and throwaway scripts.",
		"Do not treat the project cwd itself as scratch space.",
		"Do not make durable project changes. This is review only.",
		"If you believe a durable project change is necessary, explain that recommendation in your final answer instead of doing it.",
		"",
		"You do not have access to launching further subagents from here.",
		"Perform an independent code review of the assigned review target. Your final assistant answer is the only content that will be returned to the main agent, so make it self-contained and useful.",
	].join("\n");
}

function buildSubagentInstructionsFile(task: ResolvedTask, cwd: string): string {
	return buildSubagentInstructions(task, cwd);
}

function buildSubagentUserPrompt(task: ResolvedTask, cwd: string): string {
	const parts = [
		"<persistent_review_subagent_instructions>",
		buildSubagentInstructions(task, cwd),
		"</persistent_review_subagent_instructions>",
		"",
		"<review_rubric>",
		REVIEW_RUBRIC,
		"</review_rubric>",
		"",
		"<review_target>",
		task.whatToReview,
		"</review_target>",
	];
	if (task.focus) {
		parts.push("", "<neutral_focus>", task.focus, "</neutral_focus>");
	}
	parts.push(
		"",
		"Important: follow the rubric above. The caller supplied only the review target and optional neutral focus; do not infer suspected findings from the wording. Report only concrete, actionable issues you can prove from the code.",
	);
	return parts.join("\n");
}

function buildMainSystemPromptAddition(): string {
	return [
		"Review subagents:",
		`- You have a ${TOOL_NAME} tool that launches fresh same-cwd Pi review subagent sessions in parallel.`,
		"- Only launch review subagents when the user explicitly asks for subagents/parallel agents to review something, or unmistakably asks you to delegate review work to other agents.",
		`- You may launch at most ${MAX_SUBAGENTS} review subagents in one tool call. If the user asks for multiple reviewers, use one parallel tool call rather than sequential calls when possible.`,
		"- The tool already injects the standard review rubric and output format into each review subagent prompt.",
		"- When calling the tool, specify only what to review and optional neutral focus areas. Do not paste review instructions, formatting requirements, expected verdicts, or suspected findings into the review target.",
		"- Avoid biasing review subagents. Do not tell them what bugs you expect unless the user explicitly asked to verify a specific concern; if so, label it as user-provided focus.",
		"- Each review subagent is a brand-new session named `[Review Subagent] <description>`. Choose short, distinctive descriptions; if repeating a similar review, add your own suffix like `#2`.",
		"- The tool returns only each review subagent's final answer to your context. Synthesize those answers for the user, deduplicate findings, and call out disagreements or uncertainty.",
		"- By default review subagents inherit your current model and thinking level. If the user asks for a different model/thinking, set per-reviewer `model` and/or `thinking`.",
		"- Model overrides may be loose names, but you should resolve ambiguity before launching when possible. If a name could refer to multiple providers/models, ask the user which provider/model they mean instead of guessing. You can inspect models with `pi --list-models <query>` if needed.",
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
	state.usage.input += Number(usage.input || 0);
	state.usage.output += Number(usage.output || 0);
	state.usage.cacheRead += Number(usage.cacheRead || 0);
	state.usage.cacheWrite += Number(usage.cacheWrite || 0);
	state.usage.cost += Number(usage.cost?.total || 0);
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

function buildToolPartial(states: RuntimeState[]) {
	const lines = states.map((state) => {
		const status = fitColumn(`${statusIcon(state.status)} ${state.status}`, 12);
		const usage = fixedUsage(state.usage);
		const name = fitColumn(state.sessionName, 56);
		const activity = state.error ?? state.lastActivity;
		return `${status} ${usage} ${name} ${activity}`;
	});
	return {
		content: [{ type: "text" as const, text: lines.join("\n") || "subagents preparing..." }],
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
		if (this.task.modelRef) args.push("--model", this.task.modelRef);
		if (this.task.thinking) args.push("--thinking", this.task.thinking);

		const invocation = getPiInvocation(args);
		this.child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				[WORKER_ENV]: WORKER_ENV_VALUE,
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
			state.lastActivity = oneLine(update.delta || "writing…", 100);
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
		return;
	}
	if (event.type === "agent_end") {
		const text = finalAssistantText(event.messages || []);
		if (text) state.finalAnswer = text;
		state.status = "done";
		state.lastActivity = "finished";
	}
}

async function prepareTasks(params: LaunchParams, ctx: ExtensionContext, pi: ExtensionAPI): Promise<{ tasks?: ResolvedTask[]; errors?: string[] }> {
	const errors: string[] = [];
	const whatToReview = cleanText(params.what_to_review || "");
	if (!whatToReview) errors.push("what_to_review is required and should describe only the review target");
	if (!Array.isArray(params.reviewers) || params.reviewers.length === 0) errors.push("reviewers must contain at least one review subagent");
	if (Array.isArray(params.reviewers) && params.reviewers.length > MAX_SUBAGENTS) errors.push(`at most ${MAX_SUBAGENTS} review subagents may be launched at once`);
	if (errors.length > 0) return { errors };

	const availableModels = ctx.modelRegistry.getAvailable() as Model<any>[];
	const currentModelRef = getCurrentModelRef(ctx);
	const currentThinking = pi.getThinkingLevel() as ThinkingLevel;
	const resolved: Array<Omit<ResolvedTask, "sandboxDir" | "systemPromptPath">> = [];

	params.reviewers.forEach((reviewer, index) => {
		const description = sanitizeDescription(reviewer.description || "");
		const focus = cleanText(reviewer.focus || "");
		if (!description) errors.push(`reviewer ${index + 1}: description is required`);

		let modelOverride = reviewer.model?.trim();
		let thinking = reviewer.thinking ?? currentThinking;
		let explicitThinking = Boolean(reviewer.thinking);
		let modelRefForTask = currentModelRef;

		if (modelOverride) {
			const parsed = parseModelSpec(modelOverride);
			modelOverride = parsed.query;
			if (parsed.thinking) {
				if (reviewer.thinking && reviewer.thinking !== parsed.thinking) {
					errors.push(`reviewer ${index + 1}: model override includes :${parsed.thinking} but thinking is also set to ${reviewer.thinking}`);
				} else {
					thinking = parsed.thinking;
					explicitThinking = true;
				}
			}

			const match = resolveModelOverride(modelOverride, availableModels);
			if (!match.ok) {
				errors.push(`reviewer ${index + 1} (${description}): ${match.message}`);
			} else {
				modelRefForTask = modelRef(match.model);
				const thinkingError = validateRequestedThinking(match.model, thinking, explicitThinking);
				if (thinkingError) errors.push(`reviewer ${index + 1} (${description}): ${thinkingError}`);
			}
		}

		resolved.push({
			...reviewer,
			description,
			focus: focus || undefined,
			whatToReview,
			index,
			sessionName: `${SESSION_PREFIX} ${description}`,
			modelRef: modelRefForTask,
			thinking,
		});
	});

	if (errors.length > 0) return { errors };

	const withSandboxes: ResolvedTask[] = [];
	for (const task of resolved) {
		const sandboxRoot = path.join(tmpdir(), "pi-subagents");
		await mkdir(sandboxRoot, { recursive: true });
		const unique = `${slugify(task.description)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
		const sandboxDir = path.join(sandboxRoot, unique);
		await mkdir(sandboxDir, { recursive: true });
		const systemPromptPath = path.join(sandboxDir, "REVIEW_SUBAGENT_SYSTEM_PROMPT.md");
		const finalTask = { ...task, sandboxDir, systemPromptPath };
		await writeFile(systemPromptPath, buildSubagentInstructionsFile(finalTask, ctx.cwd), "utf8");
		withSandboxes.push(finalTask);
	}

	return { tasks: withSandboxes };
}

async function runSubagent(task: ResolvedTask, ctx: ExtensionContext, state: RuntimeState, emit: () => void, signal?: AbortSignal): Promise<ChildResult> {
	state.status = "starting";
	state.lastActivity = "starting pi rpc session…";
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
		await client.send("prompt", { message: buildSubagentUserPrompt(task, ctx.cwd) }, 30_000);
		try {
			const stateResponse = await client.send("get_state", {}, 5_000);
			const data = stateResponse.data || {};
			if (typeof data.sessionFile === "string") state.sessionFile = data.sessionFile;
		} catch {
			// Session path is nice-to-have only.
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
			} else if (!sawAgentEnd && state.status !== "done") {
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
		} else if (state.status !== "done") {
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

function buildFinalToolResult(results: ChildResult[]) {
	const sections = results.map(({ state }) => {
		const title = `## ${state.sessionName}`;
		if (state.status === "error" || state.status === "aborted") {
			const body = state.finalAnswer || state.error || "Subagent failed without a final answer.";
			return `${title}\n\n[${state.status}]\n${body}`;
		}
		return `${title}\n\n${state.finalAnswer || "(Subagent finished without a final answer.)"}`;
	});
	const failures = results.filter((result) => result.state.status === "error" || result.state.status === "aborted").length;
	return {
		content: [{ type: "text" as const, text: [...sections, FINAL_RESULT_DISCLAIMER].join("\n\n") }],
		details: {
			failures,
			results: results.map((result) => ({
				description: result.state.description,
				sessionName: result.state.sessionName,
				sessionFile: result.state.sessionFile,
				sandboxDir: result.state.sandboxDir,
				status: result.state.status,
				error: result.state.error,
				usage: result.state.usage,
			})),
		},
		isError: failures === results.length,
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	if (isWorker()) return;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildMainSystemPromptAddition()}`,
	}));

	pi.registerTool({
		name: TOOL_NAME,
		label: "Launch Review Subagents",
		description: `Launch 1-${MAX_SUBAGENTS} fresh same-cwd Pi review subagents in parallel. The extension injects the review rubric and output format; callers should provide only what to review and optional neutral focus areas.`,
		parameters: Type.Object({
			what_to_review: Type.String({ description: "Neutral description of the review target. Specify only what to review; do not include review rubric, output formatting, suspected findings, or expected verdict." }),
			reviewers: Type.Array(
				Type.Object({
					description: Type.String({ description: "Short session description used as `[Review Subagent] <description>`. Make it distinctive; add #2 etc yourself for repeated reviewers." }),
					focus: Type.Optional(Type.String({ description: "Optional neutral focus area, such as 'data safety' or 'performance'. Do not include suspected findings unless the user explicitly asked to verify them." })),
					model: Type.Optional(Type.String({ description: "Optional model override. Prefer explicit provider/model-id when known; loose names are accepted only if they match one available model." })),
					thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)) as any, { description: "Optional Pi thinking level override." })),
				}),
				{ minItems: 1, maxItems: MAX_SUBAGENTS, description: `Review subagents to launch in parallel, max ${MAX_SUBAGENTS}.` },
			),
		}),
		async execute(_toolCallId, params: LaunchParams, signal, onUpdate, ctx) {
			const prepared = await prepareTasks(params, ctx, pi).catch((error) => ({ errors: [error instanceof Error ? error.message : String(error)] }));
			if (prepared.errors?.length) {
				return {
					content: [{ type: "text", text: [`Review subagents were not launched because validation failed:`, ...prepared.errors.map((error) => `- ${error}`)].join("\n") }],
					details: { errors: prepared.errors },
					isError: true,
				};
			}

			const tasks = prepared.tasks ?? [];
			const activeStates: RuntimeState[] = tasks.map((task) => ({
				index: task.index,
				description: task.description,
				sessionName: task.sessionName,
				sandboxDir: task.sandboxDir,
				modelRef: task.modelRef,
				thinking: task.thinking,
				status: "preparing",
				lastActivity: "prepared",
				finalAnswer: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
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

			const results = await Promise.all(tasks.map((task, index) => runSubagent(task, ctx, activeStates[index]!, emit, signal)));
			emit();
			return buildFinalToolResult(results);
		},
		renderCall(args, theme) {
			const count = Array.isArray((args as any)?.reviewers) ? (args as any).reviewers.length : 0;
			const label = `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("accent", `${count} reviewer${count === 1 ? "" : "s"}`)}`;
			return new Text(label, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
			const prefix = result?.isError ? theme.fg("error", "review subagents") : theme.fg("success", "review subagents");
			return new Text(`${prefix}\n\n${text}`, 0, 0);
		},
	});
}
