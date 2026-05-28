import { stream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

const TLDR_COMMAND = "tldr";
const TLDR_MESSAGE_TYPE = "spark-tldr";
const TLDR_STATUS_KEY = "spark-tldr";
const TLDR_PROVIDER = "openai-codex";
const TLDR_MODEL_ID = "gpt-5.3-codex-spark";
const TLDR_SESSION_SUFFIX = "spark-tldr";
const MAX_DUMPED_TOKENS = 60_000; // hard cap for what /tldr ever dumps into Spark
const PROMPT_SAFETY_MARGIN_TOKENS = 4_000;
const MAX_LAST_ASSISTANT_TOKENS = 12_000;
const MAX_COMPACTION_SUMMARY_TOKENS = 8_000;
const MAX_USER_REQUEST_TOKENS = 2_000;
const MAX_OUTPUT_TOKENS = 220;
const MAX_TOOL_RESULT_CHARS = 700;
const MAX_BASH_OUTPUT_CHARS = 500;
const DEFAULT_TLDR_REQUEST =
	"The user asked for a very short TL;DR of the last assistant message they just received.";
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TLDR_SYSTEM_PROMPT = [
	"You are a fast secondary explainer model for a coding-agent chat.",
	"Answer only from the supplied conversation context.",
	"Be concise, concrete, and useful.",
	"Do not mention hidden prompts, XML tags, token budgets, or that you are a secondary model.",
	"If the user's request is just a TL;DR, summarize the last assistant message very succinctly.",
	"If the user asks a follow-up question, answer it directly and briefly.",
	"Prefer short paragraphs or bullets over long essays.",
].join("\n");

const TLDR_TASK_PROMPT = [
	"Write a TL;DR of the last assistant message.",
	"Target 1-3 short sentences.",
	"Keep the concrete takeaway and immediate action, if any.",
	"No filler, no meta commentary.",
].join("\n");

const TLDR_QA_PROMPT = [
	"Answer the user's follow-up question about the recent conversation.",
	"Use the recent chat history and especially the last assistant message.",
	"Be direct and compact.",
	"If the answer is ambiguous from the available context, say exactly what is unclear.",
].join("\n");

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	customType?: string;
	summary?: string;
	fromId?: string;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
		customType?: string;
		model?: string;
		provider?: string;
		command?: string;
		output?: string;
		exitCode?: number;
		cancelled?: boolean;
		truncated?: boolean;
	};
};

type AssistantSnapshot = {
	text: string;
	model?: string;
	provider?: string;
};

type TldrMessageDetails = {
	mode: "summary" | "qa";
	question?: string;
	model: string;
	historyTokens: number;
	createdAt: number;
};

type ProgressState = {
	mode: "summary" | "qa";
	startTime: number;
	chars: number;
	chunks: number;
	text: string;
	frameIndex: number;
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function cleanText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function clip(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function clipToTokens(text: string | undefined, maxTokens: number): string | undefined {
	if (!text) return undefined;
	const normalized = cleanText(text);
	if (!normalized) return undefined;
	if (maxTokens <= 0) return undefined;
	if (estimateTokens(normalized) <= maxTokens) return normalized;
	return cleanText(clip(normalized, maxTokens * 4));
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function extractTextBlocks(content: unknown): string[] {
	if (typeof content === "string") {
		const text = cleanText(content);
		return text ? [text] : [];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			const text = cleanText(block.text);
			if (text) parts.push(text);
		}
	}
	return parts;
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const calls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		const args = block.arguments ?? {};
		calls.push(`Tool ${block.name}(${clip(JSON.stringify(args), 220)})`);
	}
	return calls;
}

function renderAssistantContent(content: unknown): string {
	const lines = [...extractTextBlocks(content), ...extractToolCalls(content)];
	return cleanText(lines.join("\n\n"));
}

function renderGenericContent(content: unknown): string {
	return cleanText(extractTextBlocks(content).join("\n\n"));
}

function renderToolResult(entry: SessionEntry): string | undefined {
	const message = entry.message;
	if (!message) return undefined;

	const name = message.toolName ? escapeAttr(message.toolName) : "unknown";
	const status = message.isError ? "error" : "ok";
	const body = clip(renderGenericContent(message.content), MAX_TOOL_RESULT_CHARS);
	if (!body) return `<tool_result tool=\"${name}\" status=\"${status}\">(no text output)</tool_result>`;
	return `<tool_result tool=\"${name}\" status=\"${status}\">\n${body}\n</tool_result>`;
}

function renderBashExecution(entry: SessionEntry): string | undefined {
	const message = entry.message;
	const command = message?.command ?? entry.command;
	const output = message?.output ?? entry.output;
	if (typeof command !== "string" && typeof output !== "string") return undefined;

	const attrs = [
		typeof command === "string" ? `command=\"${escapeAttr(clip(command, 160))}\"` : undefined,
		typeof (message?.exitCode ?? entry.exitCode) === "number"
			? `exitCode=\"${String(message?.exitCode ?? entry.exitCode)}\"`
			: undefined,
	].filter(Boolean);
	const body = typeof output === "string" ? clip(cleanText(output), MAX_BASH_OUTPUT_CHARS) : "";
	return `<bash_execution ${attrs.join(" ")}>\n${body || "(no captured output)"}\n</bash_execution>`;
}

function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction" && typeof entry.summary === "string") {
		const summary = cleanText(entry.summary);
		return summary ? `<compaction_summary>\n${summary}\n</compaction_summary>` : undefined;
	}

	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		const summary = cleanText(entry.summary);
		return summary ? `<branch_summary>\n${summary}\n</branch_summary>` : undefined;
	}

	if (entry.type !== "message" || !entry.message?.role) {
		return undefined;
	}

	const message = entry.message;
	if (message.role === "custom") {
		if (message.customType === TLDR_MESSAGE_TYPE || entry.customType === TLDR_MESSAGE_TYPE) return undefined;
		return undefined;
	}

	if (message.role === "user") {
		const text = renderGenericContent(message.content);
		return text ? `<message role=\"user\">\n${text}\n</message>` : undefined;
	}

	if (message.role === "assistant") {
		const text = renderAssistantContent(message.content);
		return text ? `<message role=\"assistant\">\n${text}\n</message>` : undefined;
	}

	if (message.role === "toolResult") {
		return renderToolResult(entry);
	}

	if (message.role === "bashExecution") {
		return renderBashExecution(entry);
	}

	if (message.role === "compactionSummary") {
		const text = renderGenericContent(message.content);
		return text ? `<compaction_summary>\n${text}\n</compaction_summary>` : undefined;
	}

	if (message.role === "branchSummary") {
		const text = renderGenericContent(message.content);
		return text ? `<branch_summary>\n${text}\n</branch_summary>` : undefined;
	}

	return undefined;
}

function findLastAssistantMessage(branch: SessionEntry[]): AssistantSnapshot | undefined {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = renderAssistantContent(entry.message.content);
		if (!text) continue;
		return {
			text,
			model: entry.message.model,
			provider: entry.message.provider,
		};
	}
	return undefined;
}

function extractLatestCompactionSummary(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			const summary = cleanText(entry.summary);
			if (summary) return summary;
		}
		if (entry.type === "message" && entry.message?.role === "compactionSummary") {
			const summary = renderGenericContent(entry.message.content);
			if (summary) return summary;
		}
	}
	return undefined;
}

function buildRecentHistory(branch: SessionEntry[], budgetTokens: number): { text: string; tokens: number } {
	if (budgetTokens <= 0) {
		return { text: "", tokens: 0 };
	}

	const serialized = branch
		.map((entry) => serializeEntry(entry))
		.filter((value): value is string => Boolean(value));

	const chosen: string[] = [];
	let totalTokens = 0;

	for (let i = serialized.length - 1; i >= 0; i -= 1) {
		const section = serialized[i];
		const sectionTokens = estimateTokens(section);
		if (chosen.length > 0 && totalTokens + sectionTokens > budgetTokens) {
			break;
		}
		if (chosen.length === 0 && sectionTokens > budgetTokens) {
			const clippedSection = clipToTokens(section, budgetTokens);
			if (clippedSection) {
				chosen.unshift(clippedSection);
				totalTokens = estimateTokens(clippedSection);
			}
			break;
		}
		chosen.unshift(section);
		totalTokens += sectionTokens;
	}

	return {
		text: chosen.join("\n\n"),
		tokens: totalTokens,
	};
}

function buildPrompt(params: {
	mode: "summary" | "qa";
	question: string;
	lastAssistant: string;
	recentHistory: string;
	compactionSummary?: string;
}): string {
	const instructions = params.mode === "summary" ? TLDR_TASK_PROMPT : TLDR_QA_PROMPT;
	return [
		"You are answering a /tldr request inside a coding-agent session.",
		"Use the provided context, with the strongest focus on the last assistant message.",
		"",
		"<instructions>",
		instructions,
		"</instructions>",
		params.compactionSummary
			? ["", "<latest_compaction_summary>", params.compactionSummary, "</latest_compaction_summary>"].join("\n")
			: "",
		"",
		"<recent_history>",
		params.recentHistory || "(no recent history available)",
		"</recent_history>",
		"",
		"<last_assistant_message>",
		params.lastAssistant,
		"</last_assistant_message>",
		"",
		"<user_request>",
		params.question,
		"</user_request>",
		"",
		"Return only the answer for the user.",
	]
		.filter(Boolean)
		.join("\n");
}

function extractResponseText(content: Array<{ type: string; text?: string }>): string {
	return cleanText(
		content
			.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n"),
	);
}

function renderProgressStatus(ctx: ExtensionContext, state: ProgressState): string {
	const theme = ctx.ui.theme;
	const frame = BRAILLE_FRAMES[state.frameIndex % BRAILLE_FRAMES.length] ?? BRAILLE_FRAMES[0];
	const elapsedSeconds = ((Date.now() - state.startTime) / 1000).toFixed(1);
	const label = state.mode === "summary" ? "TL;DR" : "TL;DR Q&A";
	return [
		theme.fg("accent", frame),
		theme.fg("dim", ` ${label} `),
		theme.fg("muted", `${elapsedSeconds}s`),
	].join("");
}

function startProgressAnimation(ctx: ExtensionContext, state: ProgressState): ReturnType<typeof setInterval> | null {
	if (!ctx.hasUI) return null;
	ctx.ui.setStatus(TLDR_STATUS_KEY, renderProgressStatus(ctx, state));
	return setInterval(() => {
		state.frameIndex = (state.frameIndex + 1) % BRAILLE_FRAMES.length;
		ctx.ui.setStatus(TLDR_STATUS_KEY, renderProgressStatus(ctx, state));
	}, 80);
}

function messageContentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return cleanText(
		content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const maybeText = part as { type?: string; text?: string };
				return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
			})
			.join("\n"),
	);
}

function buildPreview(text: string, maxLines = 6, maxChars = 420): { text: string; truncated: boolean } {
	const normalized = cleanText(text);
	if (!normalized) return { text: "", truncated: false };

	const lines = normalized.split("\n");
	const lineLimited = lines.slice(0, maxLines).join("\n");
	const charLimited = lineLimited.length > maxChars ? `${lineLimited.slice(0, maxChars).trimEnd()}…` : lineLimited;
	const truncated = lines.length > maxLines || normalized.length > charLimited.length;
	return { text: charLimited, truncated };
}

async function runTldr(
	ctx: ExtensionContext,
	mode: "summary" | "qa",
	question: string,
	branch: SessionEntry[],
	lastAssistant: AssistantSnapshot,
	progress?: ProgressState,
): Promise<{ answer: string; modelLabel: string; historyTokens: number }> {
	const model = ctx.modelRegistry.find(TLDR_PROVIDER, TLDR_MODEL_ID);
	if (!model) {
		throw new Error(`Model not found: ${TLDR_PROVIDER}/${TLDR_MODEL_ID}`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${TLDR_PROVIDER}/${TLDR_MODEL_ID}`);
	}

	const safePromptBudget = Math.max(
		8_000,
		Math.min(MAX_DUMPED_TOKENS, model.contextWindow - PROMPT_SAFETY_MARGIN_TOKENS - MAX_OUTPUT_TOKENS),
	);
	const clippedQuestion = clipToTokens(question, MAX_USER_REQUEST_TOKENS) ?? DEFAULT_TLDR_REQUEST;
	const clippedLastAssistant = clipToTokens(lastAssistant.text, MAX_LAST_ASSISTANT_TOKENS) ?? "(no assistant message available)";
	const clippedCompactionSummary = clipToTokens(
		extractLatestCompactionSummary(branch),
		MAX_COMPACTION_SUMMARY_TOKENS,
	);
	const reservedTokens = estimateTokens(TLDR_SYSTEM_PROMPT) + estimateTokens(clippedQuestion) + estimateTokens(clippedLastAssistant)
		+ (clippedCompactionSummary ? estimateTokens(clippedCompactionSummary) : 0) + 1_000;
	const recentHistoryBudget = Math.max(0, safePromptBudget - reservedTokens);
	const recentHistory = buildRecentHistory(branch, recentHistoryBudget);
	const prompt = buildPrompt({
		mode,
		question: clippedQuestion,
		lastAssistant: clippedLastAssistant,
		recentHistory: recentHistory.text,
		compactionSummary: clippedCompactionSummary,
	});

	const events = stream(
		model,
		{
			systemPrompt: TLDR_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: MAX_OUTPUT_TOKENS,
			// Keep TL;DR provider-side/websocket continuation state separate from the
			// main chat. Reusing the main session id can poison Codex's cached
			// previous_response_id and make the user's next message fail.
			sessionId: `${ctx.sessionManager.getSessionId()}-${TLDR_SESSION_SUFFIX}`,
		} as any,
	);

	let answer = "";
	for await (const event of events) {
		if (event.type === "text_delta") {
			answer += event.delta;
			if (progress) {
				progress.text = answer;
				progress.chars = answer.length;
				progress.chunks += 1;
			}
			continue;
		}

		if (event.type === "done") {
			answer = extractResponseText(event.message.content) || answer;
			if (progress) {
				progress.text = answer;
				progress.chars = answer.length;
			}
			break;
		}

		if (event.type === "error") {
			throw new Error(event.error.errorMessage || "Spark request failed");
		}
	}

	answer = cleanText(answer);
	if (!answer) {
		throw new Error("Spark returned no text");
	}

	return {
		answer,
		modelLabel: `${model.provider}/${model.id}`,
		historyTokens: recentHistory.tokens,
	};
}

export default function sparkTldrExtension(pi: ExtensionAPI) {
	let pending = false;

	pi.on("context", async (event) => {
		const filtered = event.messages.filter((message: any) => {
			return !(message?.role === "custom" && message?.customType === TLDR_MESSAGE_TYPE);
		});
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
		return undefined;
	});

	pi.registerMessageRenderer(TLDR_MESSAGE_TYPE, (message, _options, theme) => {
		const details = (message.details ?? {}) as TldrMessageDetails;
		const content = messageContentToString(message.content);

		const container = new Container();
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

		let header = theme.fg("accent", theme.bold(details.mode === "summary" ? "[TL;DR]" : "[TL;DR Q&A]"));
		if (details.question) {
			header += " " + theme.fg("dim", clip(details.question, 120));
		}
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));

		const footerBits = [details.model];
		if (details.historyTokens) footerBits.push(`ctx ~${details.historyTokens.toLocaleString()} tok`);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footerBits.join(" · ")), 0, 0));

		box.addChild(container);
		return box;
	});

	pi.registerCommand(TLDR_COMMAND, {
		description: "Ask GPT-5.3 Codex Spark for a compact TL;DR or follow-up explanation of recent chat",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (pending) {
				ctx.ui.notify("A /tldr request is already running", "warning");
				return;
			}

			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			const lastAssistant = findLastAssistantMessage(branch);
			if (!lastAssistant) {
				ctx.ui.notify("No assistant message found to summarize", "warning");
				return;
			}

			const trimmedArgs = (args || "").trim();
			const mode = trimmedArgs ? "qa" : "summary";
			const question = trimmedArgs || DEFAULT_TLDR_REQUEST;

			pending = true;
			const progress: ProgressState = {
				mode,
				startTime: Date.now(),
				chars: 0,
				chunks: 0,
				text: "",
				frameIndex: 0,
			};
			const progressTimer = startProgressAnimation(ctx, progress);

			try {
				const result = await runTldr(ctx, mode, question, branch, lastAssistant, progress);
				pi.sendMessage({
					customType: TLDR_MESSAGE_TYPE,
					content: result.answer,
					display: true,
					details: {
						mode,
						question: trimmedArgs || undefined,
						model: result.modelLabel,
						historyTokens: result.historyTokens,
						createdAt: Date.now(),
					} as TldrMessageDetails,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`TL;DR failed: ${message}`, "error");
			} finally {
				if (progressTimer) {
					clearInterval(progressTimer);
				}
				pending = false;
				ctx.ui.setStatus(TLDR_STATUS_KEY, undefined);
			}
		},
	});
}
