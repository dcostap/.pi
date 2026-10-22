import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CitationSource = { refId: string; url: string };

const CITATION = /\uE200cite\uE202([^\uE201]*)\uE201/g;
const PARTIAL_CITATION = /\uE200(?:cite(?:\uE202[^\uE201]*)?|cit|ci|c)?$/;

function referenceIds(value: string): string[] {
	return value.split(/[\uE202,\s]+/).filter(Boolean);
}

function safeUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		return url.href.replace(/[<>]/g, (char) => encodeURIComponent(char));
	} catch {
		return undefined;
	}
}

/** Read only result headers, not URLs found in page text. Also accepts normalized headers. */
export function extractCitationSources(output: string): CitationSource[] {
	const sources: CitationSource[] = [];
	const headers = /^[^\r\n]+ \((https?:\/\/[^\r\n]+)\)\r?\n(?:\uE200cite\uE202([^\uE201]+)\uE201|Reference: ([\w-]+(?:, [\w-]+)*))/gm;
	for (const match of output.matchAll(headers)) {
		const url = safeUrl(match[1]);
		if (!url) continue;
		for (const refId of referenceIds(match[2] ?? match[3])) sources.push({ refId, url });
	}
	return sources;
}

/** Keep the endpoint's navigation IDs, but do not teach the model ChatGPT-only citation syntax. */
export function formatSearchOutput(output: string): string {
	return output.replace(CITATION, (_match, ids: string) => `Reference: ${referenceIds(ids).join(", ")}`);
}

export function replaceCitations(output: string, sources: ReadonlyMap<string, string>, streaming = false): string {
	return output.replace(CITATION, (_match, ids: string) => {
		const seen = new Set<string>();
		return referenceIds(ids).flatMap((refId) => {
			const url = safeUrl(sources.get(refId) ?? "");
			const key = url ?? refId;
			if (seen.has(key)) return [];
			seen.add(key);
			const label = refId.replace(/[\\`*_[\]<>]/g, "\\$&");
			return [url ? `[${new URL(url).hostname}](<${url}>)` : `[source: ${label}; URL unavailable]`];
		}).join(" ");
	}).replace(PARTIAL_CITATION, streaming ? "" : "[source unavailable]");
}

export function registerCitationHandling(pi: ExtensionAPI): void {
	const sources = new Map<string, string>();

	function remember(message: any): void {
		if (message?.role !== "toolResult" || message.toolName !== "codex_web_search") return;
		for (const block of message.content ?? []) {
			if (block.type !== "text") continue;
			for (const source of extractCitationSources(block.text)) sources.set(source.refId, source.url);
		}
		// Details retain headers that output truncation can remove.
		const saved = message.details?.citationSources;
		for (const source of Array.isArray(saved) ? saved : []) {
			if (typeof source?.refId !== "string" || typeof source.url !== "string") continue;
			const url = safeUrl(source.url);
			if (url) sources.set(source.refId, url);
		}
	}

	function restore(_event: unknown, ctx: ExtensionContext): void {
		sources.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") remember(entry.message);
		}
	}

	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_compact", restore);
	pi.on("tool_result", (event) => {
		remember({ role: "toolResult", ...event });
	});

	pi.registerMarkdownTransformer((markdown, context) => context.messageType === "assistant"
		? replaceCitations(markdown, sources, context.isStreaming)
		: markdown);

	function transformMessage<T extends { role: string; content: any }>(message: T): T {
		const searchResult = message.role === "toolResult" && (message as any).toolName === "codex_web_search";
		if (message.role !== "assistant" && !searchResult) return message;
		let changed = false;
		const content = message.content.map((block: any) => {
			if (block.type !== "text") return block;
			const text = searchResult ? formatSearchOutput(block.text) : replaceCitations(block.text, sources);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});
		return changed ? { ...message, content } : message;
	}

	// Persist standard links for RPC, print mode, exports, and managed subagent results.
	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant") return;
		const replacement = transformMessage(message);
		if (replacement !== message) return { message: replacement };
	});
	// Repair old context in memory. Do not rewrite saved session files.
	pi.on("context", ({ messages }) => ({ messages: messages.map(transformMessage) }));
}
