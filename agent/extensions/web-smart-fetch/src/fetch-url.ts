import pdf from "pdf-parse";
import TurndownService from "turndown";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionConfig } from "./config.ts";
import { getFirecrawlClient, scrapeWithFirecrawl } from "./firecrawl.ts";
import { handleGitHubUrl, parseGitHubUrl } from "./github.ts";
import { processExtractedContentWithSpark } from "./summarize.ts";
import { makeArtifactDir, saveBuffer, saveText, safeName, stripMarkdown } from "./utils.ts";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const execFileAsync = promisify(execFile);

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
		const hex = entity[1]?.toLowerCase() === "x";
		const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
		return Number.isFinite(value) ? String.fromCodePoint(value) : match;
	});
}

function extractHtmlContent(html: string): { title?: string; content: string; usedReadability: false } {
	const titleHtml = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
	const title = decodeHtmlEntities(titleHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || undefined;
	const cleaned = html
		.replace(/<!--([\s\S]*?)-->/g, "")
		.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	let markdown = "";
	try {
		markdown = turndown.turndown(cleaned).trim();
	} catch {
		// Fall through to a conservative tag-stripping extraction.
	}
	const plainText = decodeHtmlEntities(
		cleaned
			.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n\s*\n+/g, "\n")
			.trim(),
	);
	return { title, content: markdown || plainText, usedReadability: false };
}

type FetchResult = {
	method: "github" | "direct" | "jina" | "firecrawl";
	url: string;
	title?: string;
	content: string;
	artifactDir: string;
	files: Record<string, string>;
	tldr?: string;
	quality?: "OK" | "WEAK";
	qualityReason?: string;
	answer?: string;
	meta?: Record<string, unknown>;
};

const MIN_CHARS_FOR_TLDR = 5000;
const NETWORK_STEP_TIMEOUT_MS = 60_000;

function timeoutSignal(parent: AbortSignal | undefined, ms: number, label: string): { signal: AbortSignal; cancel: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms}ms`)), ms);
	const onAbort = () => controller.abort(parent?.reason || new Error("Operation aborted"));
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cancel: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}


function isProbablyPdf(contentType: string, url: string): boolean {
	return contentType.includes("application/pdf") || /\.pdf([?#].*)?$/i.test(url);
}

function isTextLike(contentType: string): boolean {
	return (
		contentType.startsWith("text/") ||
		contentType.includes("json") ||
		contentType.includes("xml") ||
		contentType.includes("javascript")
	);
}

function extractNextData(html: string): string | undefined {
	const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
	if (!nextData) return undefined;
	try {
		const parsed = JSON.parse(nextData);
		return JSON.stringify(parsed?.props ?? parsed, null, 2);
	} catch {
		return nextData;
	}
}

function isYouTubeUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
		return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
	} catch {
		return false;
	}
}

function stripVtt(vtt: string): string {
	const lines = vtt
		.replace(/^WEBVTT[\s\S]*?(?=\n\n|$)/, "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !/^\d+$/.test(line) && !line.includes("-->") && !/^NOTE\b/.test(line))
		.map((line) => line.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

	const deduped: string[] = [];
	for (const line of lines) {
		if (line !== deduped[deduped.length - 1]) deduped.push(line);
	}
	return deduped.join(" ").replace(/\s+/g, " ").trim();
}

async function tryFetchYouTubeTranscript(url: string, artifactDir: string, signal?: AbortSignal): Promise<{ text: string; file?: string; error?: string }> {
	try {
		await execFileAsync("yt-dlp", [
			"--skip-download",
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs", "en.*,en",
			"--sub-format", "vtt",
			"--output", join(artifactDir, "youtube-transcript.%(ext)s"),
			url,
		], { timeout: 45_000, signal });

		const vttFile = readdirSync(artifactDir).find((name) => /^youtube-transcript\..*\.vtt$/i.test(name) || name === "youtube-transcript.vtt");
		if (!vttFile) return { text: "", error: "yt-dlp produced no VTT subtitle file" };

		const file = join(artifactDir, vttFile);
		const text = stripVtt(readFileSync(file, "utf8"));
		return text ? { text, file } : { text: "", file, error: "subtitle file was empty after cleanup" };
	} catch (error) {
		return { text: "", error: error instanceof Error ? error.message : String(error) };
	}
}

function isLikelyTlsError(error: unknown): boolean {
	const text = [
		(error as any)?.message,
		(error as any)?.cause?.message,
		(error as any)?.cause?.code,
		String((error as any)?.cause ?? ""),
		String(error ?? ""),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	return [
		"unable_to_verify_leaf_signature",
		"unable to verify the first certificate",
		"self signed certificate",
		"self_signed_cert",
		"certificate_verify_failed",
		"unable_to_get_issuer_cert",
		"unable to get local issuer certificate",
		"cert_has_expired",
	].some((marker) => text.includes(marker));
}

function assessWeakness(text: string, html?: string, options?: { apiLike?: boolean }): string[] {
	const reasons: string[] = [];
	const lower = text.toLowerCase();
	if (!options?.apiLike && text.trim().length < 1200) reasons.push("too-short");
	for (const marker of [
		"verify you are human",
		"access denied",
		"enable javascript",
		"sign in to continue",
		"log in to continue",
		"subscribe to continue",
		"checking your browser",
		"captcha",
	]) {
		if (lower.includes(marker)) reasons.push(marker);
	}
	const boilerplateHits = ["cookie", "privacy policy", "terms of service", "all rights reserved"].filter((s) => lower.includes(s)).length;
	if (boilerplateHits >= 3 && text.length < 4000) reasons.push("boilerplate-heavy");
	if (html && /<script[^>]*>self\.__next_f\.push/i.test(html) && text.trim().length < 2000) reasons.push("next-rsc-shell");
	return [...new Set(reasons)];
}

async function fetchWithJina(url: string, signal?: AbortSignal): Promise<string> {
	const stripped = url.replace(/^https?:\/\//i, "");
	const res = await fetch(`https://r.jina.ai/http://${stripped}`, {
		headers: { Accept: "text/plain" },
		signal,
	});
	if (!res.ok) throw new Error(`Jina Reader failed: ${res.status}`);
	return (await res.text()).trim();
}

async function fetchWithCurl(url: string, artifactDir: string, signal?: AbortSignal) {
	const headerPath = join(artifactDir, "curl-headers.txt");
	const bodyPath = join(artifactDir, "curl-body.bin");
	const { stdout } = await execFileAsync(
		"curl.exe",
		[
			"-L",
			"-sS",
			"--max-time",
			"30",
			"-H",
			"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pi-Firecrawl-Smart-Fetch/0.1",
			"-H",
			"Accept: text/html,application/xhtml+xml,application/xml,text/plain,application/json,*/*",
			"-D",
			headerPath,
			"-o",
			bodyPath,
			"-w",
			"__PI_META__%{url_effective}\n%{http_code}",
			url,
		],
		{ signal },
	);

	const meta = stdout.match(/__PI_META__(.*)\r?\n(\d{3})/s);
	const finalUrl = meta?.[1]?.trim() || url;
	const status = Number(meta?.[2] || 0) || 0;
	const rawHeaders = readFileSync(headerPath, "utf8");
	const headerBlocks = rawHeaders.split(/\r?\n\r?\n(?=HTTP\/)/).filter(Boolean);
	const lastHeaderBlock = headerBlocks[headerBlocks.length - 1] || rawHeaders;
	const responseHeaders = Object.fromEntries(
		lastHeaderBlock
			.split(/\r?\n/)
			.slice(1)
			.map((line) => {
				const idx = line.indexOf(":");
				return idx >= 0 ? [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()] : null;
			})
			.filter((entry): entry is [string, string] => Boolean(entry))
			.filter(([key]) => ["content-type", "content-length", "cache-control", "etag", "last-modified"].includes(key)),
	);
	const contentType = (responseHeaders["content-type"] || "").toLowerCase();
	const body = readFileSync(bodyPath);
	return { finalUrl, status, contentType, responseHeaders, body, bodyPath, headerPath };
}

async function localFetch(url: string, config: ExtensionConfig, signal?: AbortSignal) {
	const artifactDir = makeArtifactDir(config.fetchesDir, "fetch", url);
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pi-Firecrawl-Smart-Fetch/0.1",
				Accept: "text/html,application/xhtml+xml,application/xml,text/plain,application/json,*/*",
			},
			redirect: "follow",
			signal,
		});
	} catch (error) {
		if (!isLikelyTlsError(error)) throw error;
		const curl = await fetchWithCurl(url, artifactDir, signal);
		const files: Record<string, string> = { curlHeaders: curl.headerPath };
		if (isProbablyPdf(curl.contentType, curl.finalUrl)) {
			const parsed = await pdf(curl.body);
			files.pdf = saveBuffer(join(artifactDir, safeName(basename(curl.finalUrl) || "document.pdf")), curl.body);
			files.markdown = saveText(join(artifactDir, "content.md"), parsed.text || "");
			return {
				method: "direct" as const,
				url: curl.finalUrl,
				content: parsed.text || "",
				artifactDir,
				files,
				meta: { contentType: curl.contentType, status: curl.status, headers: curl.responseHeaders, contentKind: "pdf", transport: "curl", weakReasons: assessWeakness(parsed.text || "") },
			};
		}
		if (isTextLike(curl.contentType) && !curl.contentType.includes("html")) {
			const text = curl.body.toString("utf8");
			files.raw = saveText(join(artifactDir, "raw.txt"), text);
			return {
				method: "direct" as const,
				url: curl.finalUrl,
				content: text,
				artifactDir,
				files,
				meta: { contentType: curl.contentType, status: curl.status, headers: curl.responseHeaders, contentKind: "api", isApiLike: true, transport: "curl", weakReasons: assessWeakness(text, undefined, { apiLike: true }) },
			};
		}
		const html = curl.body.toString("utf8");
		files.rawHtml = saveText(join(artifactDir, "raw.html"), html);
		const extracted = extractHtmlContent(html);
		const title = extracted.title;
		const nextData = extractNextData(html);
		const content = extracted.content || nextData || "";
		files.markdown = saveText(join(artifactDir, "content.md"), content);
		if (nextData) files.nextData = saveText(join(artifactDir, "next-data.json"), nextData);
		return {
			method: "direct" as const,
			url: curl.finalUrl,
			title,
			content,
			artifactDir,
			files,
			meta: {
				contentType: curl.contentType,
				status: curl.status,
				headers: curl.responseHeaders,
				contentKind: "html",
				transport: "curl",
				weakReasons: assessWeakness(content, html),
				usedReadability: extracted.usedReadability,
			},
		};
	}

	const finalUrl = res.url || url;
	const contentType = (res.headers.get("content-type") || "").toLowerCase();
	const responseHeaders = Object.fromEntries(
		Array.from(res.headers.entries()).filter(([key]) => ["content-type", "content-length", "cache-control", "etag", "last-modified"].includes(key.toLowerCase())),
	);
	const files: Record<string, string> = {};

	if (isProbablyPdf(contentType, finalUrl)) {
		const buffer = Buffer.from(await res.arrayBuffer());
		const parsed = await pdf(buffer);
		files.pdf = saveBuffer(join(artifactDir, safeName(basename(finalUrl) || "document.pdf")), buffer);
		files.markdown = saveText(join(artifactDir, "content.md"), parsed.text || "");
		return {
			method: "direct" as const,
			url: finalUrl,
			content: parsed.text || "",
			artifactDir,
			files,
			meta: { contentType, status: res.status, headers: responseHeaders, contentKind: "pdf", weakReasons: assessWeakness(parsed.text || "") },
		};
	}

	if (isTextLike(contentType) && !contentType.includes("html")) {
		const text = await res.text();
		files.raw = saveText(join(artifactDir, "raw.txt"), text);
		return {
			method: "direct" as const,
			url: finalUrl,
			content: text,
			artifactDir,
			files,
			meta: { contentType, status: res.status, headers: responseHeaders, contentKind: "api", isApiLike: true, weakReasons: assessWeakness(text, undefined, { apiLike: true }) },
		};
	}

	const html = await res.text();
	files.rawHtml = saveText(join(artifactDir, "raw.html"), html);
	const extracted = extractHtmlContent(html);
	const title = extracted.title;
	const nextData = extractNextData(html);
	const content = extracted.content || nextData || "";
	files.markdown = saveText(join(artifactDir, "content.md"), content);
	if (nextData) files.nextData = saveText(join(artifactDir, "next-data.json"), nextData);

	return {
		method: "direct" as const,
		url: finalUrl,
		title,
		content,
		artifactDir,
		files,
		meta: {
			contentType,
			status: res.status,
			headers: responseHeaders,
			contentKind: "html",
			weakReasons: assessWeakness(content, html),
			usedReadability: extracted.usedReadability,
		},
	};
}

function formatFetchOutput(result: FetchResult): string {
	const contentChars = result.content.length;
	const suppressTldr = result.quality === "OK" && contentChars < MIN_CHARS_FOR_TLDR;
	const sections = [
		`Method: ${result.method}`,
		`URL: ${result.url}`,
		result.title ? `Title: ${result.title}` : undefined,
		result.quality ? `Quality: ${result.quality}${result.qualityReason ? ` — ${result.qualityReason}` : ""}` : undefined,
		result.answer ? `\nAnswer:\n\n${result.answer}` : undefined,
		result.tldr && !suppressTldr ? `\nTL;DR:\n\n${result.tldr}` : undefined,
		suppressTldr ? `\nNote:\n\nPayload is short (${contentChars} chars), so TL;DR was omitted. Inspect the saved artifact directly.` : undefined,
		`\nArtifacts:`,
		...Object.entries(result.files).filter(([, v]) => Boolean(v)).map(([k, v]) => `- ${k}: ${v}`),
		`- artifactDir: ${result.artifactDir}`,
	].filter(Boolean);
	return sections.join("\n");
}

export async function fetchUrl(
	url: string,
	config: ExtensionConfig,
	ctx: any,
	prompt?: string,
	onUpdate?: (update: any) => void,
	signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const github = parseGitHubUrl(url);
	if (github) {
		onUpdate?.({ content: [{ type: "text", text: "Handling GitHub URL..." }] });
		const gh = await handleGitHubUrl(
			config,
			url,
			(message: string) => onUpdate?.({ content: [{ type: "text", text: message }] }),
			signal,
		);
		const details = {
			method: gh.kind,
			url,
			owner: gh.owner,
			repo: gh.repo,
			repoDir: gh.repoDir,
			localPath: gh.localPath,
			ref: gh.ref,
			requestedPath: gh.requestedPath,
		};
		return {
			text: gh.preview,
			details,
		};
	}

	const client = config.firecrawlApiKey ? await getFirecrawlClient(config) : undefined;

	let result: FetchResult;
	try {
		onUpdate?.({ content: [{ type: "text", text: `Fetching URL locally... (timeout ${NETWORK_STEP_TIMEOUT_MS / 1000}s)` }] });
		const localTimeout = timeoutSignal(signal, NETWORK_STEP_TIMEOUT_MS, "Local URL fetch");
		try {
			result = (await localFetch(url, config, localTimeout.signal)) as FetchResult;
		} finally {
			localTimeout.cancel();
		}
		onUpdate?.({ content: [{ type: "text", text: "Extracted local content. Assessing quality..." }] });
	} catch (error) {
		const artifactDir = makeArtifactDir(config.fetchesDir, "fetch", url);
		result = {
			method: "direct",
			url,
			content: "",
			artifactDir,
			files: {},
			meta: { localFetchError: error instanceof Error ? error.message : String(error) },
		};
	}
	if (isYouTubeUrl(result.url)) {
		onUpdate?.({ content: [{ type: "text", text: "YouTube URL detected. Trying yt-dlp captions if available..." }] });
		const transcript = await tryFetchYouTubeTranscript(result.url, result.artifactDir, signal);
		if (transcript.text) {
			result.files.youtubeTranscript = saveText(join(result.artifactDir, "youtube-transcript.md"), transcript.text);
			result.content = [
				"# YouTube transcript/captions",
				transcript.text,
				result.content.trim() ? "\n# YouTube page extraction / description" : "",
				result.content,
			].filter(Boolean).join("\n\n");
			result.meta = { ...(result.meta || {}), youtubeTranscriptStatus: "used", youtubeTranscript: transcript.file || result.files.youtubeTranscript };
		} else {
			result.meta = { ...(result.meta || {}), youtubeTranscriptStatus: "unavailable", youtubeTranscriptError: transcript.error || "No captions found" };
		}
	}

	let manualReasons = ((result.meta?.weakReasons as string[]) || []).slice();
	if (!result.content.trim()) manualReasons.push("local-fetch-failed");

	const sparkContext = {
		url,
		finalUrl: result.url,
		contentType: result.meta?.contentType as string | undefined,
		status: result.meta?.status as number | undefined,
		contentKind: (result.meta?.contentKind as "api" | "html" | "pdf" | "text" | "unknown" | undefined) || "unknown",
		method: result.method,
		headers: (result.meta?.headers as Record<string, string> | undefined) || undefined,
	};

	onUpdate?.({ content: [{ type: "text", text: prompt ? "Answering focused question from extracted content..." : "Summarizing extracted content..." }] });
	let processed = await processExtractedContentWithSpark(result.content, ctx, manualReasons, signal, prompt, sparkContext);
	result.quality = processed.quality;
	result.qualityReason = processed.reason;

	if (processed.quality === "WEAK") {
		onUpdate?.({ content: [{ type: "text", text: `Extraction looked weak (${processed.reason}). Trying Jina Reader...` }] });
		try {
			const jinaTimeout = timeoutSignal(signal, NETWORK_STEP_TIMEOUT_MS, "Jina Reader fetch");
			let jinaText = "";
			try {
				jinaText = await fetchWithJina(result.url, jinaTimeout.signal);
			} finally {
				jinaTimeout.cancel();
			}
			const jinaReasons = assessWeakness(jinaText, undefined, { apiLike: sparkContext.contentKind === "api" });
			const jinaProcessed = await processExtractedContentWithSpark(jinaText, ctx, jinaReasons, signal, prompt, {
				...sparkContext,
				method: "jina",
			});
			if (jinaText && (jinaProcessed.quality === "OK" || jinaReasons.length <= manualReasons.length)) {
				result = {
					...result,
					method: "jina",
					content: jinaText,
					quality: jinaProcessed.quality,
					qualityReason: jinaProcessed.reason,
					answer: jinaProcessed.promptAnswer,
					tldr: jinaProcessed.tldr,
					files: {
						...result.files,
						jina: saveText(join(result.artifactDir, "jina.md"), jinaText),
					},
					meta: { ...(result.meta || {}), weakReasons: jinaReasons },
				};
				manualReasons = jinaReasons;
				processed = jinaProcessed;
			}
		} catch {
			// ignore jina failure
		}
	}

	if (processed.quality === "WEAK") {
		if (client) {
			onUpdate?.({ content: [{ type: "text", text: `Escalating to Firecrawl... (timeout ${NETWORK_STEP_TIMEOUT_MS / 1000}s)` }] });
			const scraped: any = await withTimeout(
				scrapeWithFirecrawl(client, result.url),
				NETWORK_STEP_TIMEOUT_MS,
				"Firecrawl scrape",
			);
			const fcMarkdown = scraped?.markdown || scraped?.data?.markdown || "";
			const fcHtml = scraped?.html || scraped?.data?.html || "";
			const fcTitle = scraped?.metadata?.title || scraped?.data?.metadata?.title;
			const fcContent = fcMarkdown || stripMarkdown(fcHtml);
			if (fcContent) {
				const fcReasons = assessWeakness(fcContent, fcHtml, { apiLike: sparkContext.contentKind === "api" });
				const fcProcessed = await processExtractedContentWithSpark(fcContent, ctx, fcReasons, signal, prompt, {
					...sparkContext,
					method: "firecrawl",
					contentType: fcHtml ? "text/html" : sparkContext.contentType,
				});
				result = {
					method: "firecrawl",
					url: result.url,
					title: fcTitle,
					content: fcContent,
					quality: fcProcessed.quality,
					qualityReason: fcProcessed.reason,
					answer: fcProcessed.promptAnswer,
					tldr: fcProcessed.tldr,
					artifactDir: result.artifactDir,
					files: {
						...result.files,
						firecrawlMarkdown: fcMarkdown ? saveText(join(result.artifactDir, "firecrawl.md"), fcMarkdown) : "",
						firecrawlHtml: fcHtml ? saveText(join(result.artifactDir, "firecrawl.html"), fcHtml) : "",
					},
					meta: { ...(result.meta || {}), weakReasons: fcReasons, firecrawl: scraped },
				};
				processed = fcProcessed;
			}
		}
	}

	if (!result.answer && processed.promptAnswer) result.answer = processed.promptAnswer;
	if (!result.tldr && processed.tldr) result.tldr = processed.tldr;
	if (!result.quality) result.quality = processed.quality;
	if (!result.qualityReason) result.qualityReason = processed.reason;
	const suppressTldr = result.quality === "OK" && result.content.length < MIN_CHARS_FOR_TLDR;
	return {
		text: formatFetchOutput(result),
		details: {
			method: result.method,
			url: result.url,
			title: result.title,
			quality: result.quality,
			qualityReason: result.qualityReason,
			status: result.meta?.status,
			localFetchError: result.meta?.localFetchError,
			contentType: result.meta?.contentType,
			headers: result.meta?.headers,
			artifactDir: result.artifactDir,
			files: result.files,
			answer: result.answer,
			tldr: suppressTldr ? undefined : result.tldr,
			tldrOmittedForShortPayload: suppressTldr,
			prompt,
			contentChars: result.content.length,
			youtubeTranscriptStatus: result.meta?.youtubeTranscriptStatus,
			youtubeTranscriptError: result.meta?.youtubeTranscriptError,
		}, 
	};
}
