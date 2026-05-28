import { complete } from "@earendil-works/pi-ai";

const SUMMARY_PROVIDER = "openai-codex";
const SUMMARY_MODEL = "gpt-5.3-codex-spark";

type SparkProcessedContent = {
	quality: "OK" | "WEAK";
	reason: string;
	promptAnswer?: string;
	tldr?: string;
	model?: string;
	fallbackUsed?: boolean;
};

type SparkContext = {
	url?: string;
	finalUrl?: string;
	contentType?: string;
	status?: number;
	contentKind?: "api" | "html" | "pdf" | "text" | "unknown";
	method?: string;
	headers?: Record<string, string>;
};

function parseSparkJson(text: string): any | undefined {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced || trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		const obj = candidate.match(/\{[\s\S]*\}/)?.[0];
		if (!obj) return undefined;
		try {
			return JSON.parse(obj);
		} catch {
			return undefined;
		}
	}
}

function manualFallback(manualWeakReasons: string[]): SparkProcessedContent {
	if (manualWeakReasons.length > 0) {
		return {
			quality: "WEAK",
			reason: `Manual fallback flagged weak extraction: ${manualWeakReasons.join(", ")}`,
			fallbackUsed: true,
		};
	}
	return {
		quality: "OK",
		reason: "Manual fallback found no obvious weak-extraction markers.",
		fallbackUsed: true,
	};
}

function normalizeModelText(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		const text = String(value).trim();
		return text && text !== "[object Object]" ? text : undefined;
	}
}

export async function processExtractedContentWithSpark(
	text: string,
	ctx: any,
	manualWeakReasons: string[] = [],
	signal?: AbortSignal,
	focus?: string,
	sparkContext?: SparkContext,
): Promise<SparkProcessedContent> {
	if (!text?.trim()) return { quality: "WEAK", reason: "No extracted content." };

	try {
		const model = ctx.modelRegistry.find(SUMMARY_PROVIDER, SUMMARY_MODEL);
		if (!model) return manualFallback(manualWeakReasons);

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) return manualFallback(manualWeakReasons);

		const schema = focus
			? `{
  "quality": "OK" | "WEAK",
  "reason": "short explanation",
  "promptAnswer": "answer to the user's prompt from the content, or say clearly that the content does not answer it",
  "tldr": "TL;DR of the page contents"
}`
			: `{
  "quality": "OK" | "WEAK",
  "reason": "short explanation",
  "tldr": "TL;DR of the page contents"
}`;

		const prompt = [
			"You are judging and processing fetched web content for an AI coding agent.",
			"First decide whether the fetched content is usable as-is.",
			"Treat the fetch metadata as important context.",
			sparkContext?.contentKind === "api"
				? "This is an API-like/non-HTML response. Short machine-readable payloads can still be fully valid. Do NOT mark the result WEAK merely because it is brief, non-narrative, JSON, plain text, numeric, or otherwise machine-oriented."
				: undefined,
			"Return WEAK if the content is mostly login/captcha/access-denied/paywall/challenge text, JavaScript shell text, navigation/footer/boilerplate, irrelevant content, empty/truncated/malformed output, or otherwise looks like a failed fetch.",
			"Return OK if it contains enough meaningful content to inspect for its kind.",
			"For API-like responses, valid examples include JSON objects/arrays, plain version strings/numbers, small status payloads, and compact config/health responses.",
			"If quality is WEAK, do not answer anything else; set tldr to an empty string and explain why in reason.",
			"If quality is OK, generate a precise and succinct distillation of all the key ideas, key information, and key details contained within the payload, appropriate to the content kind.",
			focus ? "If quality is OK, also answer the user's prompt from the content. If the content does not really answer it, say that clearly and briefly." : undefined,
			"Return strict JSON only. No markdown fences. No extra text.",
			"Use exactly this shape:",
			schema,
			sparkContext ? `\nFetch metadata:\n${JSON.stringify(sparkContext, null, 2)}` : undefined,
			manualWeakReasons.length > 0 ? `\nHeuristic weak-signal flags:\n${manualWeakReasons.join(", ")}` : undefined,
			focus ? `\nUser prompt:\n${focus}` : undefined,
			"\nExtracted content:",
			"<content>",
			text.slice(0, 120000),
			"</content>",
		]
			.filter(Boolean)
			.join("\n");

		const response = await complete(
			model,
			{
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
				reasoningEffort: "minimal",
				signal,
			},
		);

		const raw = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
		const parsed = parseSparkJson(raw);
		const quality = String(parsed?.quality || "").toUpperCase();
		if (quality !== "OK" && quality !== "WEAK") return manualFallback(manualWeakReasons);

		return {
			quality,
			reason: normalizeModelText(parsed?.reason) || "",
			promptAnswer: focus && quality === "OK" ? normalizeModelText(parsed?.promptAnswer) : undefined,
			tldr: quality === "OK" ? normalizeModelText(parsed?.tldr) : undefined,
			model: `${SUMMARY_PROVIDER}/${SUMMARY_MODEL}`,
		};
	} catch {
		return manualFallback(manualWeakReasons);
	}
}
