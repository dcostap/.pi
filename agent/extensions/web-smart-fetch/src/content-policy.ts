export type ContentQuality = "OK" | "WEAK" | "AMBIGUOUS";

export type ContentOutput = {
	kind: "answer" | "content" | "summary" | "preview";
	text: string;
	note?: string;
	truncated: boolean;
};

const AMBIGUOUS_REASONS = new Set(["too-short", "html-too-short", "boilerplate-heavy"]);

export function classifyContentQuality(content: string, weakReasons: string[]): {
	quality: ContentQuality;
	reason: string;
} {
	if (!content.trim()) {
		return { quality: "WEAK", reason: "No extracted content." };
	}

	const reasons = [...new Set(weakReasons.filter(Boolean))];
	if (reasons.length === 0) {
		return {
			quality: "OK",
			reason: "Deterministic checks found usable extracted content.",
		};
	}

	const strongReasons = reasons.filter((reason) => !AMBIGUOUS_REASONS.has(reason));
	if (strongReasons.length > 0) {
		return {
			quality: "WEAK",
			reason: `Deterministic checks flagged weak extraction: ${strongReasons.join(", ")}`,
		};
	}

	return {
		quality: "AMBIGUOUS",
		reason: `Extraction needs a quality check: ${reasons.join(", ")}`,
	};
}

function boundedPreview(content: string, maxChars: number): { text: string; truncated: boolean } {
	if (content.length <= maxChars) return { text: content, truncated: false };
	return {
		text: `${content.slice(0, maxChars).trimEnd()}\n\n[content preview truncated]`,
		truncated: true,
	};
}

export function selectContentOutput(options: {
	content: string;
	quality: Exclude<ContentQuality, "AMBIGUOUS">;
	prompt?: string;
	answer?: string;
	tldr?: string;
	summaryThresholdChars: number;
	previewChars: number;
}): ContentOutput {
	const { content, quality, prompt, answer, tldr } = options;
	const summaryThresholdChars = Math.max(1, options.summaryThresholdChars);
	const previewChars = Math.max(1, options.previewChars);

	if (prompt && answer?.trim()) {
		return { kind: "answer", text: answer.trim(), truncated: false };
	}

	if (!prompt && quality === "OK" && content.length <= summaryThresholdChars) {
		return { kind: "content", text: content, truncated: false };
	}

	if (!prompt && quality === "OK" && tldr?.trim()) {
		return { kind: "summary", text: tldr.trim(), truncated: false };
	}

	const fallbackChars = quality === "OK" && content.length <= summaryThresholdChars
		? summaryThresholdChars
		: previewChars;
	const preview = boundedPreview(content, fallbackChars);
	let note: string | undefined;
	if (quality === "WEAK") {
		note = "Extraction remained weak after available fallbacks; returning the best captured preview.";
	} else if (prompt) {
		note = "A focused answer was unavailable; returning extracted content for the calling agent to inspect.";
	} else {
		note = "Automatic summarization was unavailable; returning a bounded preview. The full artifact is saved locally.";
	}

	return {
		kind: preview.truncated || quality === "WEAK" ? "preview" : "content",
		text: preview.text,
		note,
		truncated: preview.truncated,
	};
}
