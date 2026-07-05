import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const FAST_CHEAP_ROLE = "fastCheap";
export const MODEL_ROLES_FILE = join(homedir(), ".pi", "agent", "model-roles.local.json");

export type ModelRoleName = typeof FAST_CHEAP_ROLE | string;

export type ModelRoleConfig = {
	provider: string;
	model: string;
	reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;
	maxTokens?: number;
};

export type ModelRolesFile = {
	roles?: Record<string, ModelRoleConfig | undefined>;
};

export type ResolvedModelRole = {
	ok: true;
	role: ModelRoleName;
	config: ModelRoleConfig;
	model: any;
	auth: any;
	label: string;
};

export type ModelRoleProblem = {
	ok: false;
	role: ModelRoleName;
	reason: string;
	loudMessage: string;
};

const warnedKeys = new Set<string>();

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function validateRoleConfig(value: unknown): ModelRoleConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const provider = cleanString(record.provider);
	const model = cleanString(record.model);
	if (!provider || !model) return undefined;
	const config: ModelRoleConfig = { provider, model };
	const reasoningEffort = cleanString(record.reasoningEffort);
	if (reasoningEffort) config.reasoningEffort = reasoningEffort;
	if (typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens) && record.maxTokens > 0) {
		config.maxTokens = Math.floor(record.maxTokens);
	}
	return config;
}

function loudProblem(role: ModelRoleName, reason: string): ModelRoleProblem {
	const roleLabel = role === FAST_CHEAP_ROLE ? "FAST CHEAP" : role.toUpperCase();
	return {
		ok: false,
		role,
		reason,
		loudMessage: `${roleLabel} MODEL PROBLEM: ${reason.toUpperCase()} RUN /fast-model TO CHOOSE ONE, OR /fast-model SET provider/model.`,
	};
}

export function modelLabel(config: Pick<ModelRoleConfig, "provider" | "model">): string {
	return `${config.provider}/${config.model}`;
}

export async function readModelRolesFile(): Promise<ModelRolesFile> {
	try {
		const raw = await fs.readFile(MODEL_ROLES_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error: any) {
		if (error?.code === "ENOENT") return {};
		throw new Error(`Failed to read ${MODEL_ROLES_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function writeModelRole(role: ModelRoleName, config: ModelRoleConfig | undefined): Promise<void> {
	const file = await readModelRolesFile();
	const roles = { ...(file.roles ?? {}) };
	if (config) roles[role] = config;
	else delete roles[role];
	await fs.mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await fs.writeFile(MODEL_ROLES_FILE, JSON.stringify({ ...file, roles }, null, 2) + "\n", "utf8");
}

export async function getModelRoleConfig(role: ModelRoleName): Promise<ModelRoleConfig | undefined> {
	const file = await readModelRolesFile();
	return validateRoleConfig(file.roles?.[role]);
}

export async function resolveModelRole(ctx: any, role: ModelRoleName = FAST_CHEAP_ROLE): Promise<ResolvedModelRole | ModelRoleProblem> {
	let config: ModelRoleConfig | undefined;
	try {
		config = await getModelRoleConfig(role);
	} catch (error) {
		return loudProblem(role, error instanceof Error ? error.message : String(error));
	}

	if (!config) {
		return loudProblem(role, `${role} is not configured`);
	}

	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) {
		return loudProblem(role, `configured model was not found: ${modelLabel(config)}`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) {
		return loudProblem(role, `configured model is not usable: ${modelLabel(config)}: ${auth?.error ?? "auth failed"}`);
	}

	return {
		ok: true,
		role,
		config,
		model,
		auth,
		label: `${model.provider}/${model.id}`,
	};
}

export function notifyModelRoleProblem(
	ctx: any,
	problem: ModelRoleProblem,
	options: { onceKey?: string } = {},
): void {
	const key = options.onceKey ? `${problem.role}:${options.onceKey}:${problem.reason}` : undefined;
	if (key) {
		if (warnedKeys.has(key)) return;
		warnedKeys.add(key);
	}
	ctx.ui?.notify?.(problem.loudMessage, "error");
}
