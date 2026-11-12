/**
 * Session auto-naming
 *
 * Uses the configured fast cheap model to name the session.
 * - Automatic: after the first run of an unnamed session. While the model reports
 *   that the subject is still unknown, it tries again after later runs.
 * - Manual: `/name_auto [guidance]` renames now with the same code.
 * A name that the user sets with `/name` (or `--name`, as subagents do) is never replaced automatically.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { FAST_CHEAP_ROLE, getModelRoleRequestOptions, resolveModelRole } from "./_shared/model-roles";

const COMMAND = "name_auto";
const STATUS_KEY = "name-auto";
const STATE_TYPE = "name-auto";

const OUTPUT_MAX_TOKENS = 80;
const MAX_NAME_CHARS = 72;
// Same selection budget as t3code: names need the user's goal, not the transcript.
const MAX_CONTEXT_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 2_000;
const ASSISTANT_RESERVE_CHARS = 2_000;
const MIN_MESSAGE_CHARS = 200;
// Stops a session that stays vague ("hi", "thanks") from paying on every run.
const MAX_REFINEMENT_ATTEMPTS = 5;

const SYSTEM_PROMPT = `You name coding-agent sessions so the user can recognize them weeks later.
Return only JSON: {"name": string, "needsRefinement": boolean}.
Set needsRefinement to true only if the subject is still unknown, such as "fix this", an unexplained link or image, or small talk. Otherwise set it to false.

Rules:
- 3-7 words, at most ${MAX_NAME_CHARS} characters.
- Name the subject and the goal. Ignore instructions about how the agent should do the work.
- Capture the umbrella goal, not one step or one finding.
- Ignore workflow and deliverables such as plans, reviews, tests, commits, PRs and CI unless they are the topic.
- Do not name models, subagents or tools unless they are the topic.
- Do not claim the work is done.
- Do not copy and cut the user's message.
- No quotes, labels or trailing punctuation.`;

type Section = { role: "user" | "assistant"; text: string };
export type NameState = { name: string; needsRefinement: boolean; attempt: number };
type Suggestion = { name: string; needsRefinement: boolean };

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

const CUT_MARKER = "\n[...]\n";

function clipMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const available = maxChars - CUT_MARKER.length;
	let head = Math.ceil(available / 2);
	let tail = available - head;
	// A lone surrogate serializes to an escape that provider JSON parsers reject.
	if (/[\ud800-\udbff]/.test(text[head - 1] ?? "")) head -= 1;
	if (/[\udc00-\udfff]/.test(text[text.length - tail] ?? "")) tail -= 1;
	return text.slice(0, head) + CUT_MARKER + text.slice(text.length - tail);
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return cleanText(content);
	if (!Array.isArray(content)) return "";
	const text = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	const image = message.role === "user" && content.some((part) => part?.type === "image");
	return cleanText(image ? `${text}\n[Image attached]` : text);
}

function sectionsFromBranch(entries: SessionEntry[]): Section[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "message") return [];
		const message = (entry as any).message;
		if (message?.role !== "user" && message?.role !== "assistant") return [];
		const text = messageText(message);
		return text ? [{ role: message.role, text }] : [];
	});
}

/** Keeps the first user message, then the newest user messages, then the newest assistant replies. */
export function buildNamingContext(sections: Section[]): string {
	const chosen = new Map<number, string>();
	let remaining = MAX_CONTEXT_CHARS;
	const add = (index: number, limit: number) => {
		if (chosen.has(index)) return;
		const cap = Math.min(limit, remaining);
		if (cap < MIN_MESSAGE_CHARS) return;
		const text = clipMiddle(sections[index].text, cap);
		chosen.set(index, text);
		remaining -= text.length;
	};

	const firstUser = sections.findIndex((section) => section.role === "user");
	if (firstUser >= 0) add(firstUser, MAX_MESSAGE_CHARS);
	for (let i = sections.length - 1; i >= 0; i--) {
		if (sections[i].role === "user") add(i, Math.min(MAX_MESSAGE_CHARS, remaining - ASSISTANT_RESERVE_CHARS));
	}
	for (let i = sections.length - 1; i >= 0; i--) {
		if (sections[i].role === "assistant") add(i, MAX_MESSAGE_CHARS);
	}

	const omitted = chosen.size < sections.length || [...chosen].some(([i, text]) => text !== sections[i].text);
	const body = sections.flatMap((section, i) => (chosen.has(i) ? [`${section.role.toUpperCase()}:\n${chosen.get(i)}`] : []));
	return (omitted ? "[Some content omitted]\n\n" : "") + body.join("\n\n");
}

function currentNameLine(currentName: string | undefined, temporary: boolean): string {
	if (!currentName) return "";
	// "Keep it if accurate" anchors the model; a temporary name was a guess, so it gets no such protection.
	return temporary
		? `The current name ${JSON.stringify(currentName)} is a temporary guess because the subject was unclear. If the subject is still unclear, set needsRefinement to true again.`
		: `Current name: ${JSON.stringify(currentName)}. Keep it unchanged if it is still accurate. Replace it only with a meaningfully better name.`;
}

function buildPrompt(context: string, currentName: string | undefined, temporary: boolean, guidance: string | undefined): string {
	return [
		currentNameLine(currentName, temporary),
		guidance ? `Additional user naming guidance: ${guidance}` : "",
		"<conversation>",
		context,
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

/** Reads the model's JSON. Unparseable output becomes a final name, so a broken reply cannot cause repeated calls. */
export function parseSuggestion(raw: string): Suggestion {
	const json = raw.match(/\{[\s\S]*\}/)?.[0];
	if (json) {
		try {
			const parsed = JSON.parse(json);
			if (typeof parsed?.name === "string") {
				return { name: sanitizeName(parsed.name), needsRefinement: parsed.needsRefinement === true };
			}
		} catch {}
	}
	return { name: sanitizeName(raw), needsRefinement: false };
}

function latestState(ctx: ExtensionContext): NameState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry.type === "custom" && entry.customType === STATE_TYPE) return entry.data as NameState;
	}
	return undefined;
}

function isTemporary(currentName: string | undefined, state: NameState | undefined): boolean {
	return Boolean(currentName) && state?.name === currentName && state.needsRefinement;
}

/** An unnamed session gets a name; a vague auto name gets more tries; any other name is the user's. */
export function shouldAutoName(currentName: string | undefined, state: NameState | undefined): boolean {
	if (!currentName) return true;
	return isTemporary(currentName, state) && state!.attempt < MAX_REFINEMENT_ATTEMPTS;
}

async function suggestName(
	ctx: ExtensionContext,
	currentName: string | undefined,
	temporary: boolean,
	guidance: string | undefined,
	signal: AbortSignal,
): Promise<Suggestion | null> {
	const fastModel = await resolveModelRole(ctx, FAST_CHEAP_ROLE);
	if (!fastModel.ok) throw new Error(fastModel.loudMessage);

	const context = buildNamingContext(sectionsFromBranch(ctx.sessionManager.getBranch()));
	if (!context.trim()) throw new Error("No conversation history found");

	const response = await ctx.modelRegistry.complete(
		fastModel.model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(context, currentName, temporary, guidance) }], timestamp: Date.now() }],
		},
		{
			apiKey: fastModel.auth.apiKey,
			headers: fastModel.auth.headers,
			...getModelRoleRequestOptions(fastModel, { maxTokensCap: OUTPUT_MAX_TOKENS }),
			signal,
			sessionId: ctx.sessionManager.getSessionId(),
		},
	);
	if (response.stopReason === "aborted") return null;
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Fast cheap model request failed");

	const suggestion = parseSuggestion(responseText(response));
	if (!suggestion.name) throw new Error("Fast cheap model returned an empty name");
	return suggestion;
}

export default function nameAutoExtension(pi: ExtensionAPI) {
	let pending = false;
	let autoRun: { controller: AbortController; done: Promise<void> } | undefined;
	// One failure stops automatic naming for this session, so a broken model setup does not warn on every run.
	let autoFailed = false;

	const apply = (suggestion: Suggestion, attempt: number) => {
		if (suggestion.name !== pi.getSessionName()) pi.setSessionName(suggestion.name);
		pi.appendEntry<NameState>(STATE_TYPE, { ...suggestion, attempt });
	};

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || pending || autoFailed) return;
		const currentName = pi.getSessionName();
		const state = latestState(ctx);
		if (!shouldAutoName(currentName, state)) return;

		pending = true;
		const controller = new AbortController();
		const attempt = currentName ? (state?.attempt ?? 0) + 1 : 1;
		// Fire and forget: naming must not delay the next run.
		const done = suggestName(ctx, currentName, isTemporary(currentName, state), undefined, controller.signal)
			.then((suggestion) => {
				// A `/name` typed while the request ran wins.
				if (suggestion && !controller.signal.aborted && pi.getSessionName() === currentName) apply(suggestion, attempt);
			})
			.catch((error) => {
				if (controller.signal.aborted) return;
				autoFailed = true;
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(message.includes("MODEL PROBLEM") ? message : `Auto-naming failed: ${message}`, "warning");
			})
			.finally(() => {
				autoRun = undefined;
				pending = false;
			});
		autoRun = { controller, done };
	});

	pi.on("session_shutdown", () => {
		autoRun?.controller.abort();
	});

	pi.registerCommand(COMMAND, {
		description: "Ask the configured fast cheap model for a short session name and set it",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (!ctx.hasUI) {
				ctx.ui.notify("/name_auto requires interactive or RPC UI mode", "error");
				return;
			}

			// The manual request replaces a running automatic one.
			if (autoRun) {
				autoRun.controller.abort();
				await autoRun.done;
			}
			if (pending) {
				ctx.ui.notify("A naming request is already running", "warning");
				return;
			}

			pending = true;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "naming…"));

			try {
				const currentName = pi.getSessionName();
				const temporary = isTemporary(currentName, latestState(ctx));
				const result = await ctx.ui.custom<Suggestion | { error: string } | null>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Asking the fast cheap model for a name...");
					loader.onAbort = () => done(null);
					suggestName(ctx, currentName, temporary, args.trim() || undefined, loader.signal)
						.then(done)
						.catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
					return loader;
				});

				if (result === null) {
					ctx.ui.notify("Name generation cancelled", "info");
					return;
				}
				if ("error" in result) throw new Error(result.error);

				apply(result, 1);
				ctx.ui.notify(result.name === currentName ? `Name unchanged: ${result.name}` : `Session named: ${result.name}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message.includes("MODEL PROBLEM") ? message : `/name_auto failed: ${message}`, "error");
			} finally {
				pending = false;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
