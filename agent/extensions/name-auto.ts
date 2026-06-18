/**
 * /name_auto extension
 *
 * Uses the hardcoded Codex Spark model to suggest a short session/thread name,
 * then replaces the editor with `/name <suggestion>` so the user can press Enter.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const COMMAND = "name_auto";
const SPARK_PROVIDER = "openai-codex";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const STATUS_KEY = "name-auto";

const OUTPUT_MAX_TOKENS = 40;
// Spark rejects a little before the advertised window once provider-side framing is added.
// Naming does not need a full transcript, so keep a large reserve and a hard input cap.
const PROMPT_SAFETY_MARGIN_TOKENS = 24_000;
const MAX_CONVERSATION_TOKENS = 80_000;
const MIN_CONTEXT_BUDGET_TOKENS = 1_000;
const MAX_NAME_CHARS = 72;
const TARGET_NAME_WORDS = "3-7 words";

const SYSTEM_PROMPT = [
	"You name coding-agent chat threads.",
	"Given the conversation history, produce one short descriptive thread name.",
	`Target length: ${TARGET_NAME_WORDS}.`,
	"Prefer concrete nouns: project, feature, bug, file, API, behavior.",
	"Do not include quotes, markdown, punctuation decoration, explanations, or alternatives.",
	"Return only the name text.",
].join("\n");

type AgentMessageLike = Record<string, unknown>;

function estimateTokens(text: string): number {
	// Intentionally conservative: mixed code/JSON/tool logs often tokenize denser than 4 chars/token.
	return Math.ceil(text.length / 3);
}

function cleanText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function clipAtWordBoundary(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	const clipped = normalized.slice(0, maxChars + 1);
	const lastSpace = clipped.lastIndexOf(" ");
	return (lastSpace >= Math.floor(maxChars * 0.6) ? clipped.slice(0, lastSpace) : clipped.slice(0, maxChars)).trim();
}

function clampConversationDump(text: string, maxTokens: number): { text: string; tokens: number; truncated: boolean } {
	const normalized = cleanText(text);
	const tokenCount = estimateTokens(normalized);
	if (tokenCount <= maxTokens) {
		return { text: normalized, tokens: tokenCount, truncated: false };
	}

	const maxChars = Math.max(0, maxTokens * 4);
	const marker = "\n\n[... middle of conversation omitted to fit Codex Spark context window ...]\n\n";
	if (maxChars <= marker.length + 200) {
		const tail = normalized.slice(Math.max(0, normalized.length - maxChars));
		return { text: cleanText(tail), tokens: estimateTokens(tail), truncated: true };
	}

	// Keep a little of the beginning for global topic, and most of the end for the current task.
	const available = maxChars - marker.length;
	const headChars = Math.floor(available * 0.18);
	const tailChars = available - headChars;
	const clamped = cleanText(normalized.slice(0, headChars)) + marker + cleanText(normalized.slice(-tailChars));
	return { text: clamped, tokens: estimateTokens(clamped), truncated: true };
}

function entryToMessage(entry: SessionEntry): AgentMessageLike | undefined {
	if (entry.type === "message" && "message" in entry) {
		return entry.message as AgentMessageLike;
	}
	if (entry.type === "custom_message") {
		const custom = entry as SessionEntry & { customType?: string; content?: unknown; display?: boolean; details?: unknown };
		return {
			role: "custom",
			customType: custom.customType,
			content: custom.content,
			display: custom.display ?? true,
			details: custom.details,
			timestamp: Date.parse(entry.timestamp),
		};
	}
	if (entry.type === "compaction") {
		const compaction = entry as SessionEntry & { summary?: string; tokensBefore?: number };
		return {
			role: "compactionSummary",
			summary: compaction.summary ?? "",
			tokensBefore: compaction.tokensBefore ?? 0,
			timestamp: Date.parse(entry.timestamp),
		};
	}
	if (entry.type === "branch_summary") {
		const branchSummary = entry as SessionEntry & { summary?: string; fromId?: string };
		return {
			role: "branchSummary",
			summary: branchSummary.summary ?? "",
			fromId: branchSummary.fromId ?? "",
			timestamp: Date.parse(entry.timestamp),
		};
	}
	return undefined;
}

function buildConversationDump(entries: SessionEntry[]): string {
	const messages = entries.map(entryToMessage).filter((message): message is AgentMessageLike => Boolean(message));
	if (messages.length === 0) return "";

	try {
		return serializeConversation(convertToLlm(messages as any));
	} catch (_error) {
		// Fallback: still give Spark the raw session data rather than failing on an unexpected message shape.
		return entries.map((entry) => JSON.stringify(entry)).join("\n");
	}
}

function buildPrompt(conversation: string, extraGuidance: string | undefined): string {
	return [
		"Name this coding-agent thread based on the conversation history below.",
		extraGuidance ? `Additional user naming guidance: ${extraGuidance}` : "",
		"",
		"Rules:",
		`- Return exactly one short name (${TARGET_NAME_WORDS}).`,
		`- Maximum ${MAX_NAME_CHARS} characters.`,
		"- No quotes, no bullet, no period, no colon prefix like 'Name:'.",
		"- If the conversation is about implementing this command, name it accordingly.",
		"",
		"<conversation>",
		conversation || "(empty conversation)",
		"</conversation>",
	].filter(Boolean).join("\n");
}

function responseText(message: Message): string {
	return cleanText(
		message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n"),
	);
}

function sanitizeName(raw: string): string {
	let name = cleanText(raw);
	name = name.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/```$/g, "").trim();
	name = name.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
	name = name.replace(/^[-*•]\s*/, "").trim();
	name = name.replace(/^\/?name\s+/i, "").trim();
	name = name.replace(/^name\s*:\s*/i, "").trim();
	name = name.replace(/^['\"“”‘’]+|['\"“”‘’]+$/g, "").trim();
	name = name.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	name = name.replace(/[.。]+$/g, "").trim();
	return clipAtWordBoundary(name, MAX_NAME_CHARS);
}

export default function nameAutoExtension(pi: ExtensionAPI) {
	let pending = false;

	pi.registerCommand(COMMAND, {
		description: "Ask Codex Spark for a short thread name and prefill `/name <name>`",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (!ctx.hasUI) {
				ctx.ui.notify("/name_auto requires interactive or RPC UI mode", "error");
				return;
			}

			if (pending) {
				ctx.ui.notify("A /name_auto request is already running", "warning");
				return;
			}

			pending = true;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "naming…"));

			try {
				const model = ctx.modelRegistry.find(SPARK_PROVIDER, SPARK_MODEL_ID);
				if (!model) {
					throw new Error(`Model not found: ${SPARK_PROVIDER}/${SPARK_MODEL_ID}`);
				}

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				if (!auth.apiKey) throw new Error(`No API key for ${SPARK_PROVIDER}/${SPARK_MODEL_ID}`);

				const fullDump = buildConversationDump(ctx.sessionManager.getBranch());
				if (!fullDump.trim()) {
					throw new Error("No conversation history found");
				}

				const fixedPromptTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildPrompt("", args.trim() || undefined));
				const availableContextTokens = model.contextWindow - PROMPT_SAFETY_MARGIN_TOKENS - OUTPUT_MAX_TOKENS - fixedPromptTokens;
				const conversationBudget = Math.min(MAX_CONVERSATION_TOKENS, Math.max(0, availableContextTokens));
				if (conversationBudget < MIN_CONTEXT_BUDGET_TOKENS) {
					throw new Error(
						`Model context window too small after safety padding (${conversationBudget.toLocaleString()} tokens available)`,
					);
				}
				const clamped = clampConversationDump(fullDump, conversationBudget);
				const prompt = buildPrompt(clamped.text, args.trim() || undefined);

				const result = await ctx.ui.custom<{ text: string } | { error: string } | null>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Asking Codex Spark for a name (${clamped.tokens.toLocaleString()} tok${clamped.truncated ? ", clamped" : ""})...`,
					);
					loader.onAbort = () => done(null);

					const generate = async () => {
						const response = await complete(
							model,
							{
								systemPrompt: SYSTEM_PROMPT,
								messages: [
									{
										role: "user",
										content: [{ type: "text", text: prompt }],
										timestamp: Date.now(),
									},
								],
							},
							{
								apiKey: auth.apiKey,
								headers: auth.headers,
								maxTokens: OUTPUT_MAX_TOKENS,
								signal: loader.signal,
								sessionId: ctx.sessionManager.getSessionId(),
							},
						);

						if (response.stopReason === "aborted") return null;
						if (response.stopReason === "error") {
							throw new Error(response.errorMessage || "Codex Spark request failed");
						}

						return { text: responseText(response) };
					};

					generate().then(done).catch((error) => {
						console.error("/name_auto failed:", error);
						done({ error: error instanceof Error ? error.message : String(error) });
					});

					return loader;
				});

				if (result === null) {
					ctx.ui.notify("Name generation cancelled", "info");
					return;
				}
				if ("error" in result) {
					throw new Error(result.error);
				}

				const name = sanitizeName(result.text);
				if (!name) {
					throw new Error("Codex Spark returned an empty name");
				}

				ctx.ui.setEditorText(`/name ${name}`);
				ctx.ui.notify("Name suggestion loaded. Press Enter to apply or edit it first.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/name_auto failed: ${message}`, "error");
			} finally {
				pending = false;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
