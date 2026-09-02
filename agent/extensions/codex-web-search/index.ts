import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	accountIdFromToken,
	buildCodexSearchRequest,
	getHeader,
	resolveCodexSearchUrl,
	selectSearchTools,
	type CodexWebSearchParams,
} from "./protocol.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_SEARCH_MODEL = "gpt-5.6-luna";
const RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const CODEX_PROVIDER_IDS = new Set(["openai-codex", "openai-codex-secondary"]);

const SearchQuery = Type.Object({
	q: Type.String({ description: "Search query" }),
	recency: Type.Optional(Type.Integer({ minimum: 0, description: "Only include results from this many recent days" })),
	domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Optional allowed domains" })),
});

const Parameters = Type.Object({
	search_query: Type.Optional(Type.Array(SearchQuery, { minItems: 1, maxItems: 4 })),
	open: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String({ description: "A result reference or URL" }),
		lineno: Type.Optional(Type.Integer({ minimum: 0 })),
	}), { minItems: 1, maxItems: 4 })),
	click: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String(),
		id: Type.Integer({ minimum: 0 }),
	}), { minItems: 1, maxItems: 4 })),
	find: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String(),
		pattern: Type.String(),
	}), { minItems: 1, maxItems: 4 })),
	response_length: Type.Optional(StringEnum(["short", "medium", "long"] as const)),
	settings: Type.Optional(Type.Object({
		search_context_size: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	})),
});

type ToolParams = Static<typeof Parameters>;

type ResolvedCodexAuth = {
	token: string;
	accountId: string;
	searchUrl: string;
	authModel: string;
	provider: string;
};

function isCodexResponsesModel(model: any): boolean {
	return CODEX_PROVIDER_IDS.has(String(model?.provider || "").toLowerCase()) &&
		String(model?.api || "").toLowerCase().includes("codex-responses");
}

function findCodexAuthModel(ctx: ExtensionContext): any {
	if (isCodexResponsesModel(ctx.model)) return ctx.model;
	return undefined;
}

async function resolveCodexAuth(ctx: ExtensionContext): Promise<ResolvedCodexAuth> {
	const model = findCodexAuthModel(ctx);
	if (!model) throw new Error("codex_web_search is only available while an OpenAI Codex model is active.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`OpenAI Codex authentication failed: ${auth.error}. Run /login ${model.provider}.`);
	const authorization = getHeader(auth.headers as Record<string, unknown> | undefined, "authorization");
	const token = auth.apiKey || authorization?.replace(/^Bearer\s+/i, "");
	if (!token) throw new Error("OpenAI Codex authentication did not provide an access token.");
	const accountId =
		getHeader(auth.headers as Record<string, unknown> | undefined, "chatgpt-account-id") ||
		accountIdFromToken(token);
	if (!accountId) throw new Error("OpenAI Codex authentication did not provide a ChatGPT account ID.");
	const baseUrl = auth.baseUrl || model.baseUrl || DEFAULT_BASE_URL;
	return {
		token,
		accountId,
		searchUrl: process.env.PI_CODEX_SEARCH_URL?.trim() || resolveCodexSearchUrl(baseUrl),
		authModel: `${model.provider}/${model.id}`,
		provider: model.provider,
	};
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length") || 0);
	if (declaredLength > RESPONSE_LIMIT_BYTES) {
		await response.body?.cancel();
		throw new Error(`Codex search response exceeds ${formatSize(RESPONSE_LIMIT_BYTES)}`);
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		if (signal.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("Codex search was cancelled");
		}
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > RESPONSE_LIMIT_BYTES) {
			await reader.cancel();
			throw new Error(`Codex search response exceeds ${formatSize(RESPONSE_LIMIT_BYTES)}`);
		}
		chunks.push(value);
	}
	const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	return body.toString("utf8");
}

async function saveFullResult(sessionId: string, body: unknown): Promise<string> {
	const localDataDir = process.env.LOCALAPPDATA || join(homedir(), ".cache");
	const dir = join(localDataDir, "pi-codex-web-search", sessionId);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
	return path;
}

function callLabel(params: ToolParams): string {
	return params.search_query?.[0]?.q ||
		params.open?.[0]?.ref_id ||
		params.click?.[0]?.ref_id ||
		params.find?.[0]?.pattern ||
		"web";
}

function resultText(result: any): string {
	return result.content
		.filter((block: any) => block?.type === "text")
		.map((block: any) => String(block.text || ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function renderOutputPreview(output: string, expanded: boolean, theme: any): string {
	if (!output) return theme.fg("muted", "No output returned");
	const allLines = output.replace(/\r/g, "").split("\n");
	const maxLines = expanded ? 120 : 14;
	const maxChars = expanded ? 16_000 : 3_000;
	let shown = allLines.slice(0, maxLines).join("\n");
	if (shown.length > maxChars) shown = `${shown.slice(0, maxChars).trimEnd()}…`;
	const hiddenLines = Math.max(0, allLines.length - shown.split("\n").length);
	const truncated = hiddenLines > 0 || output.length > shown.length;
	let rendered = `\n\n${theme.fg("toolOutput", shown)}`;
	if (truncated) {
		const hint = expanded
			? `display truncated; ${allLines.length} total lines`
			: `${allLines.length} total lines; Ctrl+O to expand`;
		rendered += theme.fg("muted", `\n… (${hint})`);
	}
	return rendered;
}

export default function codexWebSearchExtension(pi: ExtensionAPI) {
	let firecrawlSearchDisplaced = false;

	function syncSearchTools(model: ExtensionContext["model"]): void {
		const active = pi.getActiveTools();
		const selected = selectSearchTools(active, isCodexResponsesModel(model), firecrawlSearchDisplaced);
		firecrawlSearchDisplaced = selected.firecrawlSearchDisplaced;
		if (
			selected.activeTools.length === active.length &&
			selected.activeTools.every((name, index) => name === active[index])
		) return;
		pi.setActiveTools(selected.activeTools);
	}

	pi.registerTool({
		name: "codex_web_search",
		label: "Codex Web Search",
		description: "Preferred web search tool for OpenAI Codex models. Use it instead of other web search tools for discovery and result navigation. It uses the active Pi Codex login and supports search_query, open, click, and find with stable references.",
		promptSnippet: "Preferred OpenAI Codex web search and result navigation. Use it instead of other search tools when active.",
		promptGuidelines: [
			"Use codex_web_search for web discovery and search when it is active; do not use another web search tool.",
			"Use codex_web_search open, click, and find operations to inspect its search results.",
		],
		parameters: Parameters,
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(`${theme.fg("toolTitle", theme.bold("codex_web_search"))} ${theme.fg("accent", callLabel(args))}`);
			return component;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				component.setText(theme.fg("warning", "Searching through OpenAI Codex…"));
				return component;
			}
			const output = resultText(result);
			if (context.isError) {
				component.setText(theme.fg("error", `✗ ${output || "Codex search failed"}`));
				return component;
			}
			const artifact = result.details?.artifactPath
				? `\n${theme.fg("muted", `Full result: ${result.details.artifactPath}`)}`
				: "";
			component.setText(
				theme.fg("success", "✓ Codex search complete") +
				renderOutputPreview(output, expanded, theme) +
				artifact,
			);
			return component;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Resolving OpenAI Codex authentication…" }] });
			const auth = await resolveCodexAuth(ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const searchModel = process.env.PI_CODEX_WEB_SEARCH_MODEL?.trim() || DEFAULT_SEARCH_MODEL;
			const maxOutputTokens = Number.parseInt(process.env.PI_CODEX_WEB_SEARCH_MAX_TOKENS || "2400", 10);
			const request = buildCodexSearchRequest(
				params as CodexWebSearchParams,
				sessionId,
				searchModel,
				Number.isFinite(maxOutputTokens) ? Math.max(256, Math.min(8000, maxOutputTokens)) : 2400,
			);

			onUpdate?.({ content: [{ type: "text", text: "Searching through OpenAI Codex…" }] });
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await fetch(auth.searchUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.token}`,
					"ChatGPT-Account-ID": auth.accountId,
					originator: "codex_cli_rs",
					"User-Agent": `codex_cli_rs/0.0.0 (${process.platform}; ${process.arch}) ${process.env.TERM_PROGRAM || process.env.TERM || "unknown"}`,
					version: "0.0.0",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: requestSignal,
			});
			const raw = await readResponseText(response, requestSignal);
			let parsed: any;
			try {
				parsed = raw ? JSON.parse(raw) : {};
			} catch {
				throw new Error(`Codex search returned invalid JSON (HTTP ${response.status})`);
			}
			if (!response.ok) {
				const message = String(parsed?.error?.message || parsed?.error || parsed?.message || response.statusText);
				throw new Error(`Codex search failed (HTTP ${response.status}): ${message.slice(0, 500)}`);
			}
			const output = String(parsed?.output || parsed?.output_text || parsed?.text || "").trim();
			if (!output) throw new Error("Codex search returned no output");

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let text = truncation.content;
			let artifactPath: string | undefined;
			if (truncation.truncated) {
				artifactPath = await saveFullResult(sessionId, parsed);
				text += `\n\n[Output truncated. Full result saved to: ${artifactPath}]`;
			}
			return {
				content: [{ type: "text", text }],
				details: {
					provider: auth.provider,
					authModel: auth.authModel,
					searchModel,
					resultCount: Array.isArray(parsed?.results) ? parsed.results.length : 0,
					artifactPath,
					truncated: truncation.truncated,
				},
			};
		},
	});

	pi.on("session_start", (_event, ctx) => syncSearchTools(ctx.model));
	pi.on("model_select", (event) => syncSearchTools(event.model));
}
