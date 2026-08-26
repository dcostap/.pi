import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SubagentRole } from "./roles.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CONTEXT_MODES = ["fresh", "transcript", "clone"] as const;
const MAX_SYSTEM_PROMPT_BYTES = 1024 * 1024;
export const MAX_SHARED_PROMPT_BYTES = 256 * 1024;
const MAX_EXPANDED_BATCH_ASSIGNMENT_BYTES = 16 * 1024 * 1024;

export type StartSpec = {
	title: string;
	task: string;
	model: string;
	thinking: (typeof THINKING_LEVELS)[number];
	role?: string;
	cwd?: string;
	context?: (typeof CONTEXT_MODES)[number];
	context_files?: boolean;
	system_prompt?: string;
	system_prompt_file?: string;
};

export type BatchSpec = {
	title: string;
	shared_prompt: string;
	role?: string;
	context_files?: boolean;
	agents: StartSpec[];
};

export type ParsedStartRequest = { specs: StartSpec[]; batch?: BatchSpec };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function validateStartSpec(value: unknown, location: string): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return [`${location}: expected object`];
	const allowed = new Set(["title", "task", "model", "thinking", "role", "cwd", "context", "context_files", "system_prompt", "system_prompt_file"]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}.${key}: unknown property`);
	for (const key of ["title", "task", "model"] as const) {
		if (typeof value[key] !== "string" || !cleanText(value[key] as string)) errors.push(`${location}.${key}: required non-empty string`);
	}
	if (!(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) errors.push(`${location}.thinking: required; expected one of ${THINKING_LEVELS.join(", ")}`);
	if (value.role !== undefined && (typeof value.role !== "string" || !cleanText(value.role))) errors.push(`${location}.role: expected non-empty string`);
	if (value.cwd !== undefined && (typeof value.cwd !== "string" || !cleanText(value.cwd))) errors.push(`${location}.cwd: expected non-empty string`);
	if (value.context !== undefined && !(CONTEXT_MODES as readonly unknown[]).includes(value.context)) errors.push(`${location}.context: expected one of ${CONTEXT_MODES.join(", ")}`);
	if (value.context_files !== undefined && typeof value.context_files !== "boolean") errors.push(`${location}.context_files: expected boolean`);
	if (value.system_prompt !== undefined && (typeof value.system_prompt !== "string" || !cleanText(value.system_prompt))) errors.push(`${location}.system_prompt: expected non-empty string`);
	if (value.system_prompt_file !== undefined && (typeof value.system_prompt_file !== "string" || !cleanText(value.system_prompt_file))) errors.push(`${location}.system_prompt_file: expected non-empty string`);
	if (value.system_prompt !== undefined && value.system_prompt_file !== undefined) errors.push(`${location}: system_prompt and system_prompt_file are mutually exclusive`);
	if ((value.system_prompt !== undefined || value.system_prompt_file !== undefined) && value.context !== undefined && value.context !== "fresh") errors.push(`${location}: custom system prompts require fresh context`);
	return errors;
}

function validateBatchSpec(value: unknown, location: string): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return [`${location}: expected object`];
	const allowed = new Set(["title", "shared_prompt", "role", "context_files", "agents"]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}.${key}: unknown property`);
	for (const key of ["title", "shared_prompt"] as const) {
		if (typeof value[key] !== "string" || !cleanText(value[key] as string)) errors.push(`${location}.${key}: required non-empty string`);
	}
	if (typeof value.shared_prompt === "string" && utf8Bytes(value.shared_prompt) > MAX_SHARED_PROMPT_BYTES) errors.push(`${location}.shared_prompt: exceeds ${MAX_SHARED_PROMPT_BYTES} UTF-8 bytes`);
	if (value.role !== undefined && (typeof value.role !== "string" || !cleanText(value.role))) errors.push(`${location}.role: expected non-empty string`);
	if (value.context_files !== undefined && typeof value.context_files !== "boolean") errors.push(`${location}.context_files: expected boolean`);
	if (!Array.isArray(value.agents) || value.agents.length === 0) errors.push(`${location}.agents: required non-empty array`);
	else {
		errors.push(...value.agents.flatMap((agent, index) => validateStartSpec(agent, `${location}.agents[${index}]`)));
		if (typeof value.shared_prompt === "string") {
			const expandedBytes = utf8Bytes(value.shared_prompt) * value.agents.length
				+ value.agents.reduce((sum, agent) => sum + (isRecord(agent) && typeof agent.task === "string" ? utf8Bytes(agent.task) : 0), 0);
			if (expandedBytes > MAX_EXPANDED_BATCH_ASSIGNMENT_BYTES) errors.push(`${location}: expanded shared and individual assignments exceed ${MAX_EXPANDED_BATCH_ASSIGNMENT_BYTES} UTF-8 bytes`);
		}
	}
	return errors;
}

export function normalizeLegacyStartValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeLegacyStartValue);
	if (!isRecord(value)) return value;
	const normalized: Record<string, unknown> = { ...value };
	if (typeof normalized.profile === "string") {
		if (normalized.role === undefined) normalized.role = normalized.profile;
		delete normalized.profile;
	}
	if (isRecord(normalized.batch)) normalized.batch = normalizeLegacyStartValue(normalized.batch);
	if (Array.isArray(normalized.agents)) normalized.agents = normalized.agents.map(normalizeLegacyStartValue);
	return normalized;
}

export function parseStartRequest(value: unknown, location: string): ParsedStartRequest {
	const normalized = normalizeLegacyStartValue(value);
	if (Array.isArray(normalized)) {
		if (normalized.length === 0) throw new Error(`${location}: legacy start array must not be empty`);
		const errors = normalized.flatMap((item, index) => validateStartSpec(item, `${location}[${index}]`));
		if (errors.length > 0) throw new Error(errors.slice(0, 50).join("\n"));
		return { specs: normalized as StartSpec[] };
	}
	if (!isRecord(normalized)) throw new Error(`${location}: expected object`);
	if (Object.hasOwn(normalized, "batch")) {
		if (Object.keys(normalized).some((key) => key !== "batch")) throw new Error(`${location}: batch must be supplied by itself`);
		const errors = validateBatchSpec(normalized.batch, `${location}.batch`);
		if (errors.length > 0) throw new Error(errors.slice(0, 50).join("\n"));
		const batch = normalized.batch as BatchSpec;
		return {
			specs: batch.agents.map((agent) => ({
				...agent,
				role: agent.role ?? batch.role,
				context_files: agent.context_files ?? batch.context_files,
			})),
			batch,
		};
	}
	const errors = validateStartSpec(normalized, location);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return { specs: [normalized as StartSpec] };
}

export async function resolveSubagentCwd(requested: string | undefined, parentCwd: string): Promise<string> {
	const resolved = path.resolve(parentCwd, requested === undefined ? "." : cleanText(requested));
	const info = await stat(resolved).catch(() => {
		throw new Error(`cwd does not exist or is unavailable: ${resolved}`);
	});
	if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
	return realpath(resolved);
}

async function readCustomSystemPrompt(spec: Pick<StartSpec, "system_prompt" | "system_prompt_file">, cwd: string): Promise<Buffer | undefined> {
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

export async function combinedSystemPrompt(spec: StartSpec, role: SubagentRole | undefined, cwd: string): Promise<Buffer | undefined> {
	const custom = await readCustomSystemPrompt(spec, cwd);
	const parts = [
		role ? `<subagent_role name="${role.name}">\n${role.prompt}\n</subagent_role>` : "",
		custom ? new TextDecoder("utf-8", { fatal: true }).decode(custom) : "",
	].filter(Boolean);
	if (parts.length === 0) return undefined;
	const bytes = Buffer.from(parts.join("\n\n"), "utf8");
	if (bytes.byteLength > MAX_SYSTEM_PROMPT_BYTES) throw new Error(`combined role and custom system prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
	return bytes;
}

export function genericPrompt(task: string, sandboxDir: string, transcript?: string, sharedPrompt?: string, workingDir?: string): string {
	return [
		transcript ? `<main_session_transcript>\n${transcript}\n</main_session_transcript>\n` : "",
		"You are a managed Pi subagent. Complete the assigned task independently.",
		workingDir ? `Your working directory is: ${workingDir}` : "",
		`Your scratch sandbox is: ${sandboxDir}`,
		"Use the sandbox for temporary files. Do not treat the project cwd as scratch space.",
		"Do not make durable project changes unless the task explicitly asks for them.",
		"Return a concise, self-contained final answer. The parent can continue this same session later if follow-up context is useful.",
		sharedPrompt ? `\n<shared_assignment>\n${cleanText(sharedPrompt)}\n</shared_assignment>` : "",
		"",
		"<individual_task>",
		cleanText(task),
		"</individual_task>",
	].filter(Boolean).join("\n");
}

export function buildMainInstructions(roles: Map<string, SubagentRole>, canReportToParent = false): string {
	const roleText = [...roles.values()].map((role) => `- ${role.name}: ${role.description}`).join("\n");
	const parentReportRule = canReportToParent
		? "\n- Use subagent_report only for mid-task messages that the parent needs while you continue. A report ends a parent wait that includes you. Do not use it to report task or work completion. Do not use it for final reports. Pi sends your final answer to the parent automatically when you stop."
		: "";
	return `Managed subagents:
- Do not launch subagents unless the user explicitly asks for delegated/subagent work or has already established that subagents should be used for the current task.
- Use subagent_start for ordinary delegated work and formal batches. subagent_start returns immediately; continue useful work instead of polling.
- Never start Pi through bash as a substitute for subagent_start.
- Every new subagent requires an exact provider/model-id and an explicit thinking level. Never inherit or guess either value from the main session.
- Before launching, the user must have established a clear contract for which exact model and thinking level to use for that task or class of tasks. If no such contract exists, ask the user before launching. Use \`pi --list-models <query>\` to search exact IDs as needed.
- A subagent's model and thinking level remain fixed for its lifetime. Create a new subagent to change either.
- Children inherit the parent's working directory by default. Set cwd to use a different existing directory. For example, set cwd to a lead's Git worktree so its nested subagents inherit that worktree.
- Child Pi context-file discovery defaults to enabled. Set context_files to false only when the user wants the child to ignore AGENTS.md and CLAUDE.md files; this does not restrict filesystem access or disable other project resources.
- Reuse an existing subagent with subagent_send only for a direct continuation or follow-up where its previous context is useful. Create a new subagent for unrelated work, independent verification, or a fresh opinion.
- Use subagent_status only when current progress matters. Do not repeatedly poll. Status is compact and does not include transcripts or raw tool output.
- For work sharing common context, launch a formal batch with a shared_prompt and individual agent tasks. Then call subagent_wait once with its batch_id and required wait_mode. Use wait_mode "all" for the complete batch; use wait_mode "any" when the first settled result is sufficient. An "any" wait returns the settled subset and leaves the remaining agents running.
- Call subagent_wait with only wait_mode "any" to wait for the next result from any active direct subagent.
- Cancelling or timing out subagent_wait leaves unfinished subagents running.
- Use subagent_result for unattended, historical, or specific completed runs when their answer is needed outside the original batch wait.
- subagent_stop stops current work but preserves the child Pi session for later continuation.
- Multiple subagent_start calls in one assistant turn may run in parallel. For large programmatic launches, subagent_start accepts input_file by itself containing the same single-or-batch request object used inline.${parentReportRule}

Available roles${roleText ? ":" : ": none"}
${roleText}

When the user requests "<role> subagents", use that role for each launched subagent.`;
}
