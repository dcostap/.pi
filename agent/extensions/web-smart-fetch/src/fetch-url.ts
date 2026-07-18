import pdf from "pdf-parse";
import TurndownService from "turndown";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionConfig } from "./config.ts";
import { classifyContentQuality, selectContentOutput, type ContentOutput } from "./content-policy.ts";
import { getFirecrawlClient, scrapeWithFirecrawl } from "./firecrawl.ts";
import { handleGitHubUrl, parseGitHubUrl } from "./github.ts";
import { parseJinaTargetMetadata } from "./jina-response.ts";
import { assessWeakness, resolveBodyContentType } from "./quality-signals.ts";
import { readResponseBuffer, readResponseText, ResponseSizeLimitError } from "./response-body.ts";
import { processExtractedContentWithSpark } from "./summarize.ts";
import { resolveUrl, thirdPartyFallbackBlockReason, type UrlResolution } from "./url-routing.ts";
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

type HtmlExtraction = {
	title?: string;
	author?: string;
	published?: string;
	description?: string;
	wordCount?: number;
	content: string;
	extractor: "defuddle" | "turndown" | "plain-text";
	extractorError?: string;
};

function extractHtmlContentFallback(html: string, extractorError?: string): HtmlExtraction {
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
	return {
		title,
		content: markdown || plainText,
		extractor: markdown ? "turndown" : "plain-text",
		extractorError,
	};
}

async function extractHtmlContent(html: string, url: string, signal?: AbortSignal): Promise<HtmlExtraction> {
	try {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("HTML extraction aborted");
		// Keep the heavier article extractor off Pi's extension startup path.
		const [{ Defuddle }, { parseHTML }] = await Promise.all([import("defuddle/node"), import("linkedom")]);
		const { document } = parseHTML(html);
		const windowLike = (document.defaultView || document) as any;
		if (typeof windowLike.getComputedStyle !== "function") {
			windowLike.getComputedStyle = () => new Proxy({}, { get: () => "" });
		}

		const extracted = await Defuddle(document as any, url, {
			markdown: true,
			// Keep the local extractor deterministic and private. Defuddle's async
			// fallback can otherwise contact third-party site-specific APIs.
			useAsync: false,
		});
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("HTML extraction aborted");
		const content = String(extracted.content || extracted.contentMarkdown || "").trim();
		if (!content) {
			return extractHtmlContentFallback(html, "Defuddle returned no content");
		}

		const optionalText = (value: unknown): string | undefined => {
			const text = String(value || "").trim();
			return text || undefined;
		};

		return {
			title: optionalText(extracted.title),
			author: optionalText(extracted.author),
			published: optionalText(extracted.published),
			description: optionalText(extracted.description),
			wordCount: Number.isFinite(extracted.wordCount) ? extracted.wordCount : undefined,
			content,
			extractor: "defuddle",
		};
	} catch (error) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
		return extractHtmlContentFallback(html, error instanceof Error ? error.message : String(error));
	}
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
	output?: ContentOutput;
};

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

const BINARY_FILE_EXTENSION = /\.(?:ttf|otf|woff2?|eot|zip|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|webp|ico|mp3|m4a|wav|ogg|mp4|mov|avi|webm|exe|dll|so|dylib|wasm|docx?|xlsx?|pptx?)(?:[?#].*)?$/i;

function isProbablyBinary(contentType: string, url: string): boolean {
	if (isProbablyPdf(contentType, url) || isTextLike(contentType)) return false;
	return (
		BINARY_FILE_EXTENSION.test(url) ||
		contentType.startsWith("font/") ||
		contentType.startsWith("image/") ||
		contentType.startsWith("audio/") ||
		contentType.startsWith("video/") ||
		contentType.includes("octet-stream") ||
		contentType.includes("zip") ||
		contentType.includes("compressed") ||
		contentType.startsWith("application/") ||
		contentType.startsWith("model/")
	);
}

function binarySignature(buffer: Buffer): string | undefined {
	if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))) return "TrueType font";
	const ascii4 = buffer.subarray(0, 4).toString("ascii");
	if (ascii4 === "OTTO") return "OpenType font";
	if (ascii4 === "wOFF") return "WOFF font";
	if (ascii4 === "wOF2") return "WOFF2 font";
	if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) return "WebAssembly module";
	if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "ZIP archive";
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "PNG image";
	return undefined;
}

function binaryResultContent(contentType: string, byteLength: number, signature?: string): string {
	return [
		"Binary response fetched successfully.",
		`Content-Type: ${contentType || "application/octet-stream"}`,
		`Size: ${byteLength} bytes`,
		signature ? `Detected signature: ${signature}` : undefined,
	].filter(Boolean).join("\n");
}

function fileNameFromUrl(url: string, fallback: string): string {
	try {
		return safeName(basename(new URL(url).pathname) || fallback);
	} catch {
		return safeName(basename(url) || fallback);
	}
}

function isMarkdownLike(contentType: string): boolean {
	return contentType.includes("markdown") || contentType.includes("text/plain; profile=markdown");
}

function buildAcceptHeader(expectedContentType?: string): string {
	if (expectedContentType && isMarkdownLike(expectedContentType)) {
		return "text/markdown,text/plain;q=0.9,text/html;q=0.8,application/xhtml+xml;q=0.7,*/*;q=0.5";
	}
	return "text/html,application/xhtml+xml,application/xml,text/plain,application/json,*/*";
}

function extractMarkdownTitle(text: string): string | undefined {
	const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/i)?.[1] || "";
	const frontmatterTitle = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim();
	if (frontmatterTitle) return frontmatterTitle;
	return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
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

async function tryFetchYouTubeTranscript(
	url: string,
	artifactDir: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ text: string; file?: string; error?: string }> {
	const controller = new AbortController();
	let oversized: { file: string; size: number } | undefined;
	const onParentAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onParentAbort();
	else signal?.addEventListener("abort", onParentAbort, { once: true });
	const sizeMonitor = setInterval(() => {
		for (const name of readdirSync(artifactDir).filter((entry) => /^youtube-transcript\..*\.vtt(?:\.part)?$/i.test(entry))) {
			const file = join(artifactDir, name);
			try {
				const size = statSync(file).size;
				if (size > maxBytes) {
					oversized = { file, size };
					controller.abort(new ResponseSizeLimitError("YouTube transcript", maxBytes, size));
					return;
				}
			} catch {
				// File may be renamed while yt-dlp finalizes it.
			}
		}
	}, 100);

	try {
		await execFileAsync("yt-dlp", [
			"--skip-download",
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs", "en.*,en",
			"--sub-format", "vtt",
			"--output", join(artifactDir, "youtube-transcript.%(ext)s"),
			url,
		], { timeout: 45_000, signal: controller.signal });

		const vttFile = readdirSync(artifactDir).find((name) => /^youtube-transcript\..*\.vtt$/i.test(name) || name === "youtube-transcript.vtt");
		if (!vttFile) return { text: "", error: "yt-dlp produced no VTT subtitle file" };

		const file = join(artifactDir, vttFile);
		const size = statSync(file).size;
		if (size > maxBytes) {
			rmSync(file, { force: true });
			return { text: "", error: `YouTube transcript exceeds the ${maxBytes}-byte limit (${size} bytes)` };
		}
		const text = stripVtt(readFileSync(file, "utf8"));
		return text ? { text, file } : { text: "", file, error: "subtitle file was empty after cleanup" };
	} catch (error) {
		if (oversized) {
			rmSync(oversized.file, { force: true });
			return {
				text: "",
				error: `YouTube transcript exceeds the ${maxBytes}-byte limit (${oversized.size} bytes)`,
			};
		}
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
		return { text: "", error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearInterval(sizeMonitor);
		signal?.removeEventListener("abort", onParentAbort);
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

async function fetchWithJina(
	url: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ text: string; status: number; proxyStatus: number; finalUrl: string; serviceUrl: string }> {
	const targetUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
	const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
		headers: { Accept: "text/plain" },
		signal,
	});
	if (!res.ok) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`Jina Reader failed: ${res.status}`);
	}
	const text = (await readResponseText(res, maxBytes, "Jina Reader response", signal)).trim();
	const target = parseJinaTargetMetadata(text, targetUrl, res.status);
	return {
		text,
		status: target.status,
		proxyStatus: res.status,
		finalUrl: target.finalUrl,
		serviceUrl: res.url || `https://r.jina.ai/${targetUrl}`,
	};
}

async function fetchWithCurl(
	url: string,
	artifactDir: string,
	maxTextBytes: number,
	maxPdfBytes: number,
	expectedContentType: string | undefined,
	signal?: AbortSignal,
) {
	const startedAt = Date.now();
	const headerPath = join(artifactDir, "curl-headers.txt");
	const bodyPath = join(artifactDir, "curl-body.bin");
	const transferLimit = isProbablyPdf(expectedContentType || "", url) ? maxPdfBytes : maxTextBytes;
	const controller = new AbortController();
	let observedOversize: number | undefined;
	const onParentAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onParentAbort();
	else signal?.addEventListener("abort", onParentAbort, { once: true });
	const sizeMonitor = setInterval(() => {
		try {
			const size = statSync(bodyPath).size;
			if (size > transferLimit) {
				observedOversize = size;
				controller.abort(new ResponseSizeLimitError("curl response", transferLimit, size));
			}
		} catch {
			// The output file may not exist yet.
		}
	}, 50);
	let stdout = "";
	try {
		({ stdout } = await execFileAsync(
			"curl.exe",
			[
			"-L",
			"-sS",
			"--max-time",
			"30",
			"--max-filesize",
			String(transferLimit),
			"-H",
			"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pi-Firecrawl-Smart-Fetch/0.1",
			"-H",
			`Accept: ${buildAcceptHeader(expectedContentType)}`,
			"-D",
			headerPath,
			"-o",
			bodyPath,
			"-w",
			"__PI_META__%{url_effective}\n%{http_code}",
			url,
			],
			{ signal: controller.signal },
		));
	} catch (error) {
		rmSync(bodyPath, { force: true });
		if (observedOversize !== undefined) {
			throw new ResponseSizeLimitError("curl response", transferLimit, observedOversize);
		}
		if (Number((error as { code?: unknown })?.code) === 63) {
			throw new ResponseSizeLimitError("curl response", transferLimit);
		}
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
		throw error;
	} finally {
		clearInterval(sizeMonitor);
		signal?.removeEventListener("abort", onParentAbort);
	}

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
	const actualContentType = (responseHeaders["content-type"] || "").toLowerCase();
	const body = readFileSync(bodyPath);
	const decoded = body.toString("utf8");
	const contentType = resolveBodyContentType(actualContentType, decoded, expectedContentType);
	const limit = isProbablyPdf(contentType, finalUrl) ? maxPdfBytes : maxTextBytes;
	if (body.byteLength > limit) {
		rmSync(bodyPath, { force: true });
		throw new ResponseSizeLimitError("curl response", limit, body.byteLength);
	}
	rmSync(bodyPath, { force: true });
	return { finalUrl, status, contentType, responseHeaders, body, headerPath, fetchMs: Date.now() - startedAt };
}

async function localFetch(
	url: string,
	config: ExtensionConfig,
	signal?: AbortSignal,
	expectedContentType?: string,
) {
	const startedAt = Date.now();
	const artifactDir = makeArtifactDir(config.fetchesDir, "fetch", url);
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pi-Firecrawl-Smart-Fetch/0.1",
				Accept: buildAcceptHeader(expectedContentType),
			},
			redirect: "follow",
			signal,
		});
	} catch (error) {
		if (!isLikelyTlsError(error)) throw error;
		const curl = await fetchWithCurl(
			url,
			artifactDir,
			config.maxTextResponseBytes,
			config.maxPdfResponseBytes,
			expectedContentType,
			signal,
		);
		const files: Record<string, string> = { curlHeaders: curl.headerPath };
		if (isProbablyPdf(curl.contentType, curl.finalUrl)) {
			const extractStartedAt = Date.now();
			const parsed = await pdf(curl.body);
			const content = parsed.text || "";
			files.pdf = saveBuffer(join(artifactDir, safeName(basename(curl.finalUrl) || "document.pdf")), curl.body);
			files.markdown = saveText(join(artifactDir, "content.md"), content);
			return {
				method: "direct" as const,
				url: curl.finalUrl,
				content,
				artifactDir,
				files,
				meta: {
					contentType: curl.contentType,
					status: curl.status,
					headers: curl.responseHeaders,
					contentKind: "pdf",
					transport: "curl",
					weakReasons: assessWeakness(content, undefined, { status: curl.status }),
					diagnostics: {
						strategy: "curl-tls-fallback",
						cache: "none",
						status: curl.status,
						finalUrl: curl.finalUrl,
						fetchMs: curl.fetchMs,
						extractMs: Date.now() - extractStartedAt,
						originalBytes: curl.body.byteLength,
						extractedChars: content.length,
						truncated: false,
					},
				},
			};
		}
		if (isTextLike(curl.contentType) && !curl.contentType.includes("html")) {
			const text = curl.body.toString("utf8");
			const markdownLike = isMarkdownLike(curl.contentType);
			files.raw = saveText(join(artifactDir, "raw.txt"), text);
			return {
				method: "direct" as const,
				url: curl.finalUrl,
				title: markdownLike ? extractMarkdownTitle(text) : undefined,
				content: text,
				artifactDir,
				files,
				meta: {
					contentType: curl.contentType,
					status: curl.status,
					headers: curl.responseHeaders,
					contentKind: markdownLike ? "text" : "api",
					isApiLike: true,
					transport: "curl",
					weakReasons: assessWeakness(text, undefined, { apiLike: true, status: curl.status }),
					diagnostics: {
						strategy: "curl-tls-fallback",
						cache: "none",
						status: curl.status,
						finalUrl: curl.finalUrl,
						fetchMs: curl.fetchMs,
						extractMs: 0,
						originalBytes: curl.body.byteLength,
						originalChars: text.length,
						extractedChars: text.length,
						truncated: false,
					},
				},
			};
		}
		if (isProbablyBinary(curl.contentType, curl.finalUrl)) {
			const signature = binarySignature(curl.body);
			const content = binaryResultContent(curl.contentType, curl.body.byteLength, signature);
			files.binary = saveBuffer(join(artifactDir, fileNameFromUrl(curl.finalUrl, "download.bin")), curl.body);
			return {
				method: "direct" as const,
				url: curl.finalUrl,
				content,
				artifactDir,
				files,
				meta: {
					contentType: curl.contentType,
					status: curl.status,
					headers: curl.responseHeaders,
					contentKind: "binary",
					isApiLike: true,
					binarySignature: signature,
					weakReasons: assessWeakness(content, undefined, { apiLike: true, status: curl.status }),
					diagnostics: {
						strategy: "curl-tls-fallback",
						cache: "none",
						status: curl.status,
						finalUrl: curl.finalUrl,
						fetchMs: curl.fetchMs,
						extractMs: 0,
						originalBytes: curl.body.byteLength,
						extractedChars: content.length,
						truncated: false,
					},
				},
			};
		}
		const html = curl.body.toString("utf8");
		files.rawHtml = saveText(join(artifactDir, "raw.html"), html);
		const extractStartedAt = Date.now();
		const extracted = await extractHtmlContent(html, curl.finalUrl, signal);
		const extractMs = Date.now() - extractStartedAt;
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
				weakReasons: assessWeakness(content, html, { status: curl.status }),
				extractor: extracted.extractor,
				extractorError: extracted.extractorError,
				author: extracted.author,
				published: extracted.published,
				description: extracted.description,
				wordCount: extracted.wordCount,
				diagnostics: {
					strategy: "curl-tls-fallback",
					cache: "none",
					status: curl.status,
					finalUrl: curl.finalUrl,
					fetchMs: curl.fetchMs,
					extractMs,
					originalBytes: curl.body.byteLength,
					originalChars: html.length,
					extractedChars: content.length,
					truncated: false,
				},
			},
		};
	}

	const finalUrl = res.url || url;
	const actualContentType = (res.headers.get("content-type") || "").toLowerCase();
	const responseHeaders = Object.fromEntries(
		Array.from(res.headers.entries()).filter(([key]) => ["content-type", "content-length", "cache-control", "etag", "last-modified"].includes(key.toLowerCase())),
	);
	const files: Record<string, string> = {};

	if (isProbablyPdf(actualContentType, finalUrl)) {
		const buffer = await readResponseBuffer(res, config.maxPdfResponseBytes, "PDF response", signal);
		const fetchMs = Date.now() - startedAt;
		const extractStartedAt = Date.now();
		const parsed = await pdf(buffer);
		const content = parsed.text || "";
		files.pdf = saveBuffer(join(artifactDir, safeName(basename(finalUrl) || "document.pdf")), buffer);
		files.markdown = saveText(join(artifactDir, "content.md"), content);
		return {
			method: "direct" as const,
			url: finalUrl,
			content,
			artifactDir,
			files,
			meta: {
				contentType: actualContentType || "application/pdf",
				status: res.status,
				headers: responseHeaders,
				contentKind: "pdf",
				weakReasons: assessWeakness(content, undefined, { status: res.status }),
				diagnostics: {
					strategy: "http",
					cache: "none",
					status: res.status,
					finalUrl,
					fetchMs,
					extractMs: Date.now() - extractStartedAt,
					originalBytes: buffer.byteLength,
					extractedChars: content.length,
					truncated: false,
				},
			},
		};
	}

	if (isProbablyBinary(actualContentType, finalUrl)) {
		const buffer = await readResponseBuffer(res, config.maxTextResponseBytes, "Binary response", signal);
		const fetchMs = Date.now() - startedAt;
		const signature = binarySignature(buffer);
		const content = binaryResultContent(actualContentType, buffer.byteLength, signature);
		files.binary = saveBuffer(join(artifactDir, fileNameFromUrl(finalUrl, "download.bin")), buffer);
		return {
			method: "direct" as const,
			url: finalUrl,
			content,
			artifactDir,
			files,
			meta: {
				contentType: actualContentType || "application/octet-stream",
				status: res.status,
				headers: responseHeaders,
				contentKind: "binary",
				isApiLike: true,
				binarySignature: signature,
				weakReasons: assessWeakness(content, undefined, { apiLike: true, status: res.status }),
				diagnostics: {
					strategy: "http",
					cache: "none",
					status: res.status,
					finalUrl,
					fetchMs,
					extractMs: 0,
					originalBytes: buffer.byteLength,
					extractedChars: content.length,
					truncated: false,
				},
			},
		};
	}

	const responseText = await readResponseText(res, config.maxTextResponseBytes, "Web response", signal);
	const contentType = resolveBodyContentType(actualContentType, responseText, expectedContentType);

	if (isTextLike(contentType) && !contentType.includes("html")) {
		const text = responseText;
		const markdownLike = isMarkdownLike(contentType);
		const fetchMs = Date.now() - startedAt;
		files.raw = saveText(join(artifactDir, "raw.txt"), text);
		return {
			method: "direct" as const,
			url: finalUrl,
			title: markdownLike ? extractMarkdownTitle(text) : undefined,
			content: text,
			artifactDir,
			files,
			meta: {
				contentType,
				status: res.status,
				headers: responseHeaders,
				contentKind: markdownLike ? "text" : "api",
				isApiLike: true,
				weakReasons: assessWeakness(text, undefined, { apiLike: true, status: res.status }),
				diagnostics: {
					strategy: "http",
					cache: "none",
					status: res.status,
					finalUrl,
					fetchMs,
					extractMs: 0,
					originalChars: text.length,
					extractedChars: text.length,
					truncated: false,
				},
			},
		};
	}

	const html = responseText;
	const fetchMs = Date.now() - startedAt;
	files.rawHtml = saveText(join(artifactDir, "raw.html"), html);
	const extractStartedAt = Date.now();
	const extracted = await extractHtmlContent(html, finalUrl, signal);
	const extractMs = Date.now() - extractStartedAt;
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
			weakReasons: assessWeakness(content, html, { status: res.status }),
			extractor: extracted.extractor,
			extractorError: extracted.extractorError,
			author: extracted.author,
			published: extracted.published,
			description: extracted.description,
			wordCount: extracted.wordCount,
			diagnostics: {
				strategy: "http",
				cache: "none",
				status: res.status,
				finalUrl,
				fetchMs,
				extractMs,
				originalChars: html.length,
				extractedChars: content.length,
				truncated: false,
			},
		},
	};
}

function formatFetchOutput(result: FetchResult): string {
	const diagnostics = result.meta?.diagnostics as AttemptDiagnostic | undefined;
	const outputLabel = {
		answer: "Answer",
		content: "Extracted content",
		summary: "TL;DR",
		preview: "Extracted content preview",
	}[result.output?.kind || "content"];
	const sections = [
		`Method: ${result.method}`,
		`URL: ${result.url}`,
		result.meta?.adapterId && result.meta.adapterId !== "default" ? `Adapter: ${result.meta.adapterId}` : undefined,
		result.meta?.rewritten ? `Fetch target: ${result.meta.fetchUrl}` : undefined,
		diagnostics?.strategy
			? `Strategy: ${diagnostics.strategy}${typeof diagnostics.status === "number" ? ` (HTTP ${diagnostics.status})` : ""}`
			: undefined,
		result.title ? `Title: ${result.title}` : undefined,
		result.method === "direct" && result.meta?.extractor ? `Extractor: ${result.meta.extractor}` : undefined,
		result.meta?.author ? `Author: ${result.meta.author}` : undefined,
		result.meta?.published ? `Published: ${result.meta.published}` : undefined,
		typeof result.meta?.wordCount === "number" ? `Word count: ${result.meta.wordCount}` : undefined,
		result.quality ? `Quality: ${result.quality}${result.qualityReason ? ` — ${result.qualityReason}` : ""}` : undefined,
		result.meta?.thirdPartyFallbackBlocked
			? `Third-party fallbacks: skipped (${result.meta.thirdPartyFallbackBlocked})`
			: undefined,
		result.output?.note ? `\nNote:\n\n${result.output.note}` : undefined,
		result.output?.text ? `\n${outputLabel}:\n\n${result.output.text}` : undefined,
		`\nArtifacts:`,
		...Object.entries(result.files).filter(([, v]) => Boolean(v)).map(([k, v]) => `- ${k}: ${v}`),
		`- artifactDir: ${result.artifactDir}`,
	].filter(Boolean);
	return sections.join("\n");
}

type CandidateAssessment = {
	quality: "OK" | "WEAK";
	reason: string;
	promptAnswer?: string;
	tldr?: string;
};

type AttemptDiagnostic = {
	strategy: string;
	cache?: "none" | "hit" | "miss";
	status?: number;
	proxyStatus?: number;
	finalUrl?: string;
	serviceUrl?: string;
	fetchMs?: number;
	extractMs?: number;
	originalBytes?: number;
	originalChars?: number;
	extractedChars?: number;
	truncated?: boolean;
	quality?: "OK" | "WEAK";
	qualityReason?: string;
	error?: string;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function attemptFromResult(result: FetchResult, assessment: CandidateAssessment): AttemptDiagnostic {
	const diagnostics = (result.meta?.diagnostics as AttemptDiagnostic | undefined) || { strategy: result.method };
	return {
		...diagnostics,
		quality: assessment.quality,
		qualityReason: assessment.reason,
	};
}

async function assessCandidate(
	content: string,
	weakReasons: string[],
	ctx: any,
	signal: AbortSignal | undefined,
	prompt: string | undefined,
	sparkContext: {
		url?: string;
		finalUrl?: string;
		contentType?: string;
		status?: number;
		contentKind?: "api" | "binary" | "html" | "pdf" | "text" | "unknown";
		method?: string;
		headers?: Record<string, string>;
	},
	onUpdate?: (update: any) => void,
): Promise<CandidateAssessment> {
	const deterministic = classifyContentQuality(content, weakReasons);
	if (deterministic.quality !== "AMBIGUOUS") {
		return { quality: deterministic.quality, reason: deterministic.reason };
	}

	onUpdate?.({ content: [{ type: "text", text: `${deterministic.reason} Asking the fast model to judge quality...` }] });
	return await processExtractedContentWithSpark(content, ctx, weakReasons, signal, prompt, sparkContext);
}

export async function fetchUrl(
	url: string,
	config: ExtensionConfig,
	ctx: any,
	prompt?: string,
	onUpdate?: (update: any) => void,
	signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const route: UrlResolution = resolveUrl(url);
	const github = route.handler === "github" ? parseGitHubUrl(route.canonicalUrl) : undefined;
	if (github) {
		const githubStartedAt = Date.now();
		onUpdate?.({ content: [{ type: "text", text: "Handling GitHub URL..." }] });
		const gh = await handleGitHubUrl(
			config,
			route.canonicalUrl,
			(message: string) => onUpdate?.({ content: [{ type: "text", text: message }] }),
			signal,
		);
		const details = {
			method: gh.kind,
			url: route.canonicalUrl,
			requestedUrl: route.requestedUrl,
			canonicalUrl: route.canonicalUrl,
			fetchUrl: route.fetchUrl,
			dedupeKey: route.dedupeKey,
			adapterId: route.adapterId,
			strategy: gh.strategy,
			cache: gh.cache,
			fetchMs: Date.now() - githubStartedAt,
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
	const attempts: AttemptDiagnostic[] = [];
	const localStartedAt = Date.now();
	try {
		onUpdate?.({ content: [{ type: "text", text: `Fetching URL locally... (timeout ${NETWORK_STEP_TIMEOUT_MS / 1000}s)` }] });
		const localTimeout = timeoutSignal(signal, NETWORK_STEP_TIMEOUT_MS, "Local URL fetch");
		try {
			result = (await localFetch(
				route.fetchUrl,
				config,
				localTimeout.signal,
				route.expectedContentType,
			)) as FetchResult;
		} finally {
			localTimeout.cancel();
		}
		onUpdate?.({ content: [{ type: "text", text: "Extracted local content. Assessing quality..." }] });
	} catch (error) {
		const artifactDir = makeArtifactDir(config.fetchesDir, "fetch", route.canonicalUrl);
		result = {
			method: "direct",
			url: route.canonicalUrl,
			content: "",
			artifactDir,
			files: {},
			meta: {
				localFetchError: errorMessage(error),
				diagnostics: {
					strategy: "http",
					cache: "none",
					finalUrl: route.fetchUrl,
					fetchMs: Date.now() - localStartedAt,
					extractedChars: 0,
					truncated: false,
					error: errorMessage(error),
				},
			},
		};
	}
	result.url = route.canonicalUrl;
	result.meta = {
		...(result.meta || {}),
		requestedUrl: route.requestedUrl,
		canonicalUrl: route.canonicalUrl,
		fetchUrl: route.fetchUrl,
		dedupeKey: route.dedupeKey,
		adapterId: route.adapterId,
		rewritten: route.rewritten,
		expectedContentType: route.expectedContentType,
	};

	if (route.handler === "youtube") {
		onUpdate?.({ content: [{ type: "text", text: "YouTube URL detected. Trying yt-dlp captions if available..." }] });
		const transcript = await tryFetchYouTubeTranscript(
			result.url,
			result.artifactDir,
			config.maxTextResponseBytes,
			signal,
		);
		if (transcript.text) {
			result.files.youtubeTranscript = saveText(join(result.artifactDir, "youtube-transcript.md"), transcript.text);
			result.content = [
				"# YouTube transcript/captions",
				transcript.text,
				result.content.trim() ? "\n# YouTube page extraction / description" : "",
				result.content,
			].filter(Boolean).join("\n\n");
			result.meta = {
				...(result.meta || {}),
				weakReasons: assessWeakness(result.content),
				diagnostics: {
					...((result.meta?.diagnostics as Record<string, unknown> | undefined) || {}),
					extractedChars: result.content.length,
				},
				youtubeTranscriptStatus: "used",
				youtubeTranscript: transcript.file || result.files.youtubeTranscript,
			};
		} else {
			result.meta = { ...(result.meta || {}), youtubeTranscriptStatus: "unavailable", youtubeTranscriptError: transcript.error || "No captions found" };
		}
	}

	let weakReasons = ((result.meta?.weakReasons as string[]) || []).slice();
	if (!result.content.trim()) weakReasons.push("local-fetch-failed");

	const sparkContext = {
		url: route.canonicalUrl,
		finalUrl: (result.meta?.diagnostics as AttemptDiagnostic | undefined)?.finalUrl || route.fetchUrl,
		contentType: result.meta?.contentType as string | undefined,
		status: result.meta?.status as number | undefined,
		contentKind: (result.meta?.contentKind as "api" | "binary" | "html" | "pdf" | "text" | "unknown" | undefined) || "unknown",
		method: result.method,
		headers: (result.meta?.headers as Record<string, string> | undefined) || undefined,
	};

	let assessment = await assessCandidate(result.content, weakReasons, ctx, signal, prompt, sparkContext, onUpdate);
	result.quality = assessment.quality;
	result.qualityReason = assessment.reason;
	result.answer = assessment.promptAnswer;
	result.tldr = assessment.tldr;
	attempts.push(attemptFromResult(result, assessment));
	const fallbackBlocked = thirdPartyFallbackBlockReason(route.fetchUrl);
	if (assessment.quality === "WEAK" && fallbackBlocked) {
		result.meta = { ...(result.meta || {}), thirdPartyFallbackBlocked: fallbackBlocked };
		onUpdate?.({
			content: [{
				type: "text",
				text: `Extraction looked weak, but third-party fallbacks were skipped to avoid forwarding credentials (${fallbackBlocked}).`,
			}],
		});
	}

	if (assessment.quality === "WEAK" && !fallbackBlocked) {
		onUpdate?.({ content: [{ type: "text", text: `Extraction looked weak (${assessment.reason}). Trying Jina Reader...` }] });
		const jinaStartedAt = Date.now();
		try {
			const jinaTimeout = timeoutSignal(signal, NETWORK_STEP_TIMEOUT_MS, "Jina Reader fetch");
			let jinaResult: {
				text: string;
				status: number;
				proxyStatus: number;
				finalUrl: string;
				serviceUrl: string;
			};
			try {
				jinaResult = await fetchWithJina(route.fetchUrl, config.maxTextResponseBytes, jinaTimeout.signal);
			} finally {
				jinaTimeout.cancel();
			}
			const jinaFetchMs = Date.now() - jinaStartedAt;
			const jinaText = jinaResult.text;
			const jinaReasons = assessWeakness(jinaText, undefined, {
				apiLike: sparkContext.contentKind === "api",
				status: jinaResult.status,
			});
			const jinaAssessment = await assessCandidate(
				jinaText,
				jinaReasons,
				ctx,
				signal,
				prompt,
				{ ...sparkContext, method: "jina" },
				onUpdate,
			);
			const jinaDiagnostics: AttemptDiagnostic = {
				strategy: "jina",
				cache: "none",
				status: jinaResult.status,
				proxyStatus: jinaResult.proxyStatus,
				finalUrl: jinaResult.finalUrl,
				serviceUrl: jinaResult.serviceUrl,
				fetchMs: jinaFetchMs,
				extractMs: 0,
				originalChars: jinaText.length,
				extractedChars: jinaText.length,
				truncated: false,
				quality: jinaAssessment.quality,
				qualityReason: jinaAssessment.reason,
			};
			attempts.push(jinaDiagnostics);
			if (jinaText && (jinaAssessment.quality === "OK" || jinaReasons.length <= weakReasons.length)) {
				result = {
					...result,
					method: "jina",
					content: jinaText,
					quality: jinaAssessment.quality,
					qualityReason: jinaAssessment.reason,
					answer: jinaAssessment.promptAnswer,
					tldr: jinaAssessment.tldr,
					files: {
						...result.files,
						jina: saveText(join(result.artifactDir, "jina.md"), jinaText),
					},
					meta: {
						...(result.meta || {}),
						status: jinaResult.status,
						weakReasons: jinaReasons,
						diagnostics: jinaDiagnostics,
					},
				};
				weakReasons = jinaReasons;
				assessment = jinaAssessment;
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			attempts.push({
				strategy: "jina",
				cache: "none",
				fetchMs: Date.now() - jinaStartedAt,
				error: errorMessage(error),
			});
		}
	}

	if (assessment.quality === "WEAK" && !fallbackBlocked) {
		if (client) {
			onUpdate?.({ content: [{ type: "text", text: `Escalating to Firecrawl... (timeout ${NETWORK_STEP_TIMEOUT_MS / 1000}s)` }] });
			const firecrawlStartedAt = Date.now();
			try {
				const scraped: any = await withTimeout(
					scrapeWithFirecrawl(client, route.fetchUrl, signal),
					NETWORK_STEP_TIMEOUT_MS,
					"Firecrawl scrape",
				);
				const firecrawlFetchMs = Date.now() - firecrawlStartedAt;
				const fcMarkdown = scraped?.markdown || scraped?.data?.markdown || "";
				const fcHtml = scraped?.html || scraped?.data?.html || "";
				const fcMetadata = scraped?.metadata || scraped?.data?.metadata || {};
				const fcTitle = fcMetadata?.title;
				const fcStatus = Number(fcMetadata?.statusCode || fcMetadata?.status || 0) || undefined;
				for (const [label, value] of [["Firecrawl markdown", fcMarkdown], ["Firecrawl HTML", fcHtml]] as const) {
					const bytes = Buffer.byteLength(value, "utf8");
					if (bytes > config.maxTextResponseBytes) {
						throw new ResponseSizeLimitError(label, config.maxTextResponseBytes, bytes);
					}
				}
				const extractStartedAt = Date.now();
				const fcContent = fcMarkdown || stripMarkdown(fcHtml);
				const fcExtractMs = Date.now() - extractStartedAt;
				if (fcContent) {
					const fcReasons = assessWeakness(fcContent, fcHtml, {
						apiLike: sparkContext.contentKind === "api",
						status: fcStatus,
					});
					const fcAssessment = await assessCandidate(
						fcContent,
						fcReasons,
						ctx,
						signal,
						prompt,
						{
							...sparkContext,
							method: "firecrawl",
							status: fcStatus,
							contentType: fcHtml ? "text/html" : sparkContext.contentType,
						},
						onUpdate,
					);
					const firecrawlDiagnostics: AttemptDiagnostic = {
						strategy: "firecrawl",
						cache: "none",
						status: fcStatus,
						finalUrl: String(fcMetadata?.sourceURL || fcMetadata?.url || result.url),
						fetchMs: firecrawlFetchMs,
						extractMs: fcExtractMs,
						originalChars: (fcHtml || fcMarkdown).length,
						extractedChars: fcContent.length,
						truncated: false,
						quality: fcAssessment.quality,
						qualityReason: fcAssessment.reason,
					};
					attempts.push(firecrawlDiagnostics);
					result = {
						method: "firecrawl",
						url: result.url,
						title: fcTitle,
						content: fcContent,
						quality: fcAssessment.quality,
						qualityReason: fcAssessment.reason,
						answer: fcAssessment.promptAnswer,
						tldr: fcAssessment.tldr,
						artifactDir: result.artifactDir,
						files: {
							...result.files,
							firecrawlMarkdown: fcMarkdown ? saveText(join(result.artifactDir, "firecrawl.md"), fcMarkdown) : "",
							firecrawlHtml: fcHtml ? saveText(join(result.artifactDir, "firecrawl.html"), fcHtml) : "",
						},
						meta: {
							...(result.meta || {}),
							status: fcStatus ?? result.meta?.status,
							weakReasons: fcReasons,
							firecrawl: scraped,
							diagnostics: firecrawlDiagnostics,
						},
					};
					weakReasons = fcReasons;
					assessment = fcAssessment;
				} else {
					attempts.push({
						strategy: "firecrawl",
						cache: "none",
						status: fcStatus,
						fetchMs: firecrawlFetchMs,
						extractedChars: 0,
						error: "Firecrawl returned no extractable content",
					});
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				attempts.push({
					strategy: "firecrawl",
					cache: "none",
					fetchMs: Date.now() - firecrawlStartedAt,
					error: errorMessage(error),
				});
			}
		}
	}

	if (assessment.quality === "OK" && prompt && !result.answer) {
		onUpdate?.({ content: [{ type: "text", text: "Answering focused question from extracted content..." }] });
		const currentDiagnostics = result.meta?.diagnostics as AttemptDiagnostic | undefined;
		const focused = await processExtractedContentWithSpark(result.content, ctx, [], signal, prompt, {
			...sparkContext,
			finalUrl: currentDiagnostics?.finalUrl || result.url,
			status: result.meta?.status as number | undefined,
			method: result.method,
		});
		if (focused.quality === "OK") {
			result.answer = focused.promptAnswer;
		}
	}

	if (
		assessment.quality === "OK" &&
		!prompt &&
		result.content.length > config.summaryThresholdChars &&
		!result.tldr
	) {
		onUpdate?.({ content: [{ type: "text", text: "Extracted content is oversized. Summarizing it..." }] });
		const currentDiagnostics = result.meta?.diagnostics as AttemptDiagnostic | undefined;
		const summarized = await processExtractedContentWithSpark(result.content, ctx, [], signal, undefined, {
			...sparkContext,
			finalUrl: currentDiagnostics?.finalUrl || result.url,
			status: result.meta?.status as number | undefined,
			method: result.method,
		});
		if (summarized.quality === "OK") {
			result.tldr = summarized.tldr;
		}
	}

	result.quality = assessment.quality;
	result.qualityReason = assessment.reason;
	result.output = selectContentOutput({
		content: result.content,
		quality: assessment.quality,
		prompt,
		answer: result.answer,
		tldr: result.tldr,
		summaryThresholdChars: config.summaryThresholdChars,
		previewChars: config.previewChars,
	});
	const selectedDiagnostics = (result.meta?.diagnostics as AttemptDiagnostic | undefined) || {
		strategy: result.method,
		cache: "none" as const,
	};
	const diagnostics = {
		...selectedDiagnostics,
		selectedStrategy: selectedDiagnostics.strategy,
		attempts,
		outputMode: result.output.kind,
		outputTruncated: result.output.truncated,
	};
	result.meta = { ...(result.meta || {}), diagnostics };

	return {
		text: formatFetchOutput(result),
			details: {
			method: result.method,
			url: result.url,
			requestedUrl: route.requestedUrl,
			canonicalUrl: route.canonicalUrl,
			fetchUrl: route.fetchUrl,
			dedupeKey: route.dedupeKey,
			adapterId: route.adapterId,
			rewritten: route.rewritten,
			expectedContentType: route.expectedContentType,
			title: result.title,
			quality: result.quality,
			qualityReason: result.qualityReason,
			status: result.meta?.status,
			localFetchError: result.meta?.localFetchError,
			contentType: result.meta?.contentType,
			strategy: selectedDiagnostics.strategy,
			cache: selectedDiagnostics.cache || "none",
			finalUrl: selectedDiagnostics.finalUrl || result.url,
			fetchMs: selectedDiagnostics.fetchMs,
			extractMs: selectedDiagnostics.extractMs,
			originalBytes: selectedDiagnostics.originalBytes,
			originalChars: selectedDiagnostics.originalChars,
			extractedChars: selectedDiagnostics.extractedChars ?? result.content.length,
			truncated: Boolean(selectedDiagnostics.truncated) || result.output.truncated,
			diagnostics,
			thirdPartyFallbackBlocked: fallbackBlocked,
			limits: {
				maxTextResponseBytes: config.maxTextResponseBytes,
				maxPdfResponseBytes: config.maxPdfResponseBytes,
				maxFirecrawlResponseBytes: config.maxFirecrawlResponseBytes,
			},
			extractor: result.meta?.extractor,
			extractorError: result.meta?.extractorError,
			author: result.meta?.author,
			published: result.meta?.published,
			description: result.meta?.description,
			wordCount: result.meta?.wordCount,
			headers: result.meta?.headers,
			artifactDir: result.artifactDir,
			files: result.files,
			answer: result.answer,
			tldr: result.output.kind === "summary" ? result.tldr : undefined,
			outputMode: result.output.kind,
			prompt,
			contentChars: result.content.length,
			youtubeTranscriptStatus: result.meta?.youtubeTranscriptStatus,
			youtubeTranscriptError: result.meta?.youtubeTranscriptError,
		}, 
	};
}
