import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
// Heavy implementation modules are intentionally lazy-loaded inside execute().
// This keeps pi startup fast: fetch-url pulls in jsdom/pdf-parse/turndown/pi-ai,
// and firecrawl pulls in @mendable/firecrawl-js. Tool registration only needs schemas/renderers.
import { join } from "node:path";
import { makeArtifactDir, preview, saveJson, saveText, truncate } from "./utils.ts";

function oneLine(value: unknown, max = 90): string {
	const text = String(value || "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderLine(text: string, theme: any, context: any) {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

function getSearchEntries(result: any): any[] {
	return [
		...(Array.isArray(result?.web) ? result.web : []),
		...(Array.isArray(result?.news) ? result.news : []),
		...(Array.isArray(result?.images) ? result.images : []),
		...(Array.isArray(result?.data) ? result.data : []),
		...(Array.isArray(result?.results) ? result.results : []),
	];
}

function entryTitle(entry: any): string {
	return entry?.title || entry?.metadata?.title || entry?.url || entry?.metadata?.sourceURL || "Untitled";
}

function clickableUrl(url: unknown, max = 88): string {
	const fullUrl = String(url || "").trim();
	if (!fullUrl) return "";
	return hyperlink(`↗ ${oneLine(fullUrl, max)}`, fullUrl);
}

function textOutput(result: any): string {
	return (result?.content || [])
		.filter((block: any) => block?.type === "text")
		.map((block: any) => String(block.text || "").replace(/\r/g, ""))
		.filter(Boolean)
		.join("\n");
}

type FirecrawlModule = {
	getFirecrawlClient: (config: ReturnType<typeof loadConfig>) => Promise<unknown>;
	scrapeWithFirecrawl: (client: unknown, url: string) => Promise<unknown>;
	searchWithFirecrawl: (client: unknown, query: string, limit?: number) => Promise<unknown>;
	crawlWithFirecrawl: (client: unknown, url: string, limit?: number) => Promise<unknown>;
};

async function loadFirecrawlModule(): Promise<FirecrawlModule> {
	const mod: any = await import("./firecrawl.ts");
	const exports = mod?.getFirecrawlClient ? mod : mod?.default?.getFirecrawlClient ? mod.default : undefined;
	if (
		typeof exports?.getFirecrawlClient !== "function" ||
		typeof exports?.scrapeWithFirecrawl !== "function" ||
		typeof exports?.searchWithFirecrawl !== "function" ||
		typeof exports?.crawlWithFirecrawl !== "function"
	) {
		throw new Error("Firecrawl support failed to load: missing expected helper exports");
	}
	return exports as FirecrawlModule;
}

function renderErrorResult(result: any, theme: any, context: any): Text | undefined {
	if (!context.isError && !result?.isError) return undefined;
	const message =
		result?.details?.error ||
		result?.error?.message ||
		result?.error ||
		textOutput(result) ||
		"Tool failed";
	return renderLine(`${theme.fg("error", "✗ Error:")} ${theme.fg("toolOutput", oneLine(message, 300))}`, theme, context);
}

function renderToolOutputBlock(output: string, expanded: boolean, theme: any, maxLines = 10): string {
	const trimmed = output.trim();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	const displayLines = expanded ? lines : lines.slice(0, maxLines);
	let text = `\n\n${theme.fg("success", "Result:")}\n${theme.fg("toolOutput", displayLines.join("\n"))}`;
	const remaining = lines.length - displayLines.length;
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines, ${lines.length} total, Ctrl+O to expand)`);
	}
	return text;
}

function githubPayloadKind(output: string): { label: string; note: string } {
	const firstLine = output.trimStart().split(/\r?\n/, 1)[0] || "";
	if (firstLine.startsWith("File: ")) {
		return {
			label: "file contents preview",
			note: "The agent received the file header plus file text from the cached checkout (tool payload capped by fetch_url).",
		};
	}
	if (firstLine.startsWith("Directory: ")) {
		return {
			label: "directory listing",
			note: "The agent received a listing of this folder from the cached checkout, not every file's contents.",
		};
	}
	if (firstLine.startsWith("Repository: ")) {
		return {
			label: "repository metadata/path",
			note: "The agent received repo/ref/local path only, not the repository contents.",
		};
	}
	return {
		label: "GitHub preview",
		note: "The agent received the preview shown below.",
	};
}

function renderGitHubInjectedBlock(output: string, expanded: boolean, theme: any): string {
	const trimmed = output.trim();
	if (!trimmed) return "";
	const totalLines = trimmed.split("\n").length;
	const totalChars = trimmed.length;
	const maxChars = expanded ? 12000 : 2400;
	const maxLines = expanded ? 160 : 14;
	const byChars = totalChars > maxChars ? truncate(trimmed, maxChars) : trimmed;
	const lines = byChars.split("\n");
	const displayLines = lines.slice(0, maxLines);
	let displayed = displayLines.join("\n");
	const lineTruncated = lines.length > displayLines.length;
	const charTruncated = totalChars > maxChars;
	if (lineTruncated || charTruncated) {
		const hint = expanded
			? `display truncated (${totalLines} lines, ${totalChars} chars in injected payload)`
			: `display truncated (${totalLines} lines, ${totalChars} chars in injected payload, Ctrl+O to expand)`;
		displayed += `\n... (${hint})`;
	}
	return `\n\n${theme.fg("success", "Injected to agent:")}\n${theme.fg("toolOutput", displayed)}`;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch one specific URL with local extraction first, external GitHub repo inspect/cache handling, and Firecrawl fallback when needed.",
		promptSnippet: "Fetch a specific URL/page/PDF, or cache an external GitHub repo locally for inspection and return its checkout path.",
		promptGuidelines: [
			"Use fetch_url when the user gives a specific URL or asks to inspect one exact page.",
			"When several URLs are worth fetching, batch 2-4 independent fetch_url calls in parallel; don't fetch whole result lists by default.",
			"Use fetch_url instead of git clone for external GitHub repos you only need to inspect; it caches locally and returns the checkout path.",
			"If the user asks you to clone a GitHub repo into the workspace so they can modify it, use normal git/workspace commands instead.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch" }),
			prompt: Type.Optional(Type.String({ description: "Optional focused question about the page. fetch_url answers it from extracted content; weak extraction may still use Firecrawl fallback if configured." })),
		}),
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("fetch_url"));
			const url = theme.fg("accent", oneLine(args.url));
			const prompt = args.prompt ? theme.fg("dim", ` · prompt: ${oneLine(args.prompt, 70)}`) : "";
			return renderLine(`${label} ${url}${prompt}`, theme, context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				const status = oneLine(textOutput(result) || result?.details?.status || "fetch_url running…", 180);
				return renderLine(theme.fg("warning", status), theme, context);
			}
			const errorResult = renderErrorResult(result, theme, context);
			if (errorResult) return errorResult;
			const d = result.details || {};
			let text = theme.fg("success", "✓");
			if (d.method) text += ` ${theme.fg("muted", d.method)}`;
			if (d.method === "github") {
				const output = textOutput(result);
				const payload = githubPayloadKind(output);
				if (d.owner && d.repo) text += `\n${theme.fg("success", "Repository:")} ${theme.fg("accent", `${d.owner}/${d.repo}`)}`;
				if (d.ref) text += `\n${theme.fg("success", "Ref:")} ${theme.fg("dim", String(d.ref))}`;
				if (d.localPath) text += `\n${theme.fg("success", "Local path:")} ${theme.fg("dim", String(d.localPath))}`;
				if (d.requestedPath) text += `\n${theme.fg("success", "Requested path:")} ${theme.fg("dim", String(d.requestedPath))}`;
				text += `\n${theme.fg("success", "Payload:")} ${theme.fg("accent", payload.label)}`;
				text += `\n${theme.fg("muted", payload.note)}`;
				text += renderGitHubInjectedBlock(output, expanded, theme);
				return renderLine(text, theme, context);
			}
			if (d.qualityReason || d.quality) {
				const quality = d.quality === "OK" ? theme.fg("success", "OK") : d.quality ? theme.fg("warning", String(d.quality)) : "";
				text += `\n${theme.fg("success", "Quality:")} ${quality}${d.qualityReason ? ` — ${String(d.qualityReason).trim()}` : ""}`;
			}
			if (d.youtubeTranscriptStatus === "used") text += `\n${theme.fg("success", "YouTube transcript:")} ${theme.fg("success", "yt-dlp captions used")}`;
			if (d.youtubeTranscriptStatus === "unavailable") text += `\n${theme.fg("warning", "YouTube transcript:")} ${theme.fg("muted", `yt-dlp unavailable/no captions${d.youtubeTranscriptError ? ` — ${oneLine(d.youtubeTranscriptError, 90)}` : ""}`)}`;
			if (d.answer) text += `\n\n${theme.fg("success", "Answer:")}\n${String(d.answer).trim()}`;
			if (d.tldr) text += `\n\n${theme.fg("success", "TL;DR:")}\n${String(d.tldr).trim()}`;
			if (!d.answer && !d.tldr) text += renderToolOutputBlock(textOutput(result), expanded, theme);
			if (d.files && Object.keys(d.files).length > 0) {
				text += `\n\n${theme.fg("success", "Artifacts:")}`;
				for (const [key, value] of Object.entries(d.files)) {
					if (value) text += `\n- ${key}: ${theme.fg("dim", String(value))}`;
				}
			}
			if (d.artifactDir) text += `\n- artifactDir: ${theme.fg("dim", d.artifactDir)}`;
			return renderLine(text, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { fetchUrl } = await import("./fetch-url.ts");
			const result = await fetchUrl(params.url, config, ctx, params.prompt, onUpdate, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "firecrawl_search",
		label: "Firecrawl Search",
		description: "Search the web with Firecrawl.",
		promptSnippet: "Search the web with Firecrawl when discovery/research is needed instead of one known URL.",
		promptGuidelines: [
			"Use firecrawl_search when the user has a research question and no exact URL.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		renderCall(args, theme, context) {
			return renderLine(`${theme.fg("toolTitle", theme.bold("firecrawl_search"))} ${theme.fg("accent", oneLine(args.query, 110))}`, theme, context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return renderLine(theme.fg("warning", "firecrawl_search running…"), theme, context);
			const errorResult = renderErrorResult(result, theme, context);
			if (errorResult) return errorResult;
			const d = result.details || {};
			let text = theme.fg("success", "✓");
			text += typeof d.count === "number" ? ` ${d.count} results` : " search complete";
			if (Array.isArray(d.topResults) && d.topResults.length > 0) {
				for (const item of d.topResults) {
					const title = oneLine(item.title || "Untitled", 92);
					const url = clickableUrl(item.url);
					text += `\n- ${theme.fg("accent", title)}${url ? `\n  ${theme.fg("dim", url)}\n` : ""}`;
				}
			}
			if (expanded && d.files?.json) text += `\nJSON: ${theme.fg("dim", d.files.json)}`;
			return renderLine(text, theme, context);
		}, 
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!config.firecrawlApiKey) throw new Error("Firecrawl is not configured. Set FIRECRAWL_API_KEY or ~/.pi/web-smart-fetch.json");
			const { getFirecrawlClient, searchWithFirecrawl } = await loadFirecrawlModule();
			const client = await getFirecrawlClient(config);
			if (!client) throw new Error("Firecrawl is not configured. Set FIRECRAWL_API_KEY or ~/.pi/web-smart-fetch.json");
			onUpdate?.({ content: [{ type: "text", text: "Searching with Firecrawl..." }] });
			const result: any = await searchWithFirecrawl(client, params.query, 10);
			const dir = makeArtifactDir(config.fetchesDir, "search", params.query);
			const files = {
				json: saveJson(join(dir, "result.json"), result),
			};
			const entries = getSearchEntries(result);
			const rows = entries
				.slice(0, 8)
				.map((r: any, i: number) => `#${i + 1} ${entryTitle(r)}\n${r.url || r.metadata?.sourceURL || ""}\n${preview(r.markdown || r.description || "", 1200)}`)
				.join("\n\n");
			return {
				content: [{ type: "text", text: `Firecrawl search results for: ${params.query}\n\n${rows}\n\nSaved full JSON: ${files.json}` }],
				details: {
					files,
					query: params.query,
					count: entries.length,
					topResults: entries.slice(0, 10).map((r: any) => ({
						title: entryTitle(r),
						url: r.url || r.metadata?.sourceURL || "",
					})),
				}, 
			};
		},
	});

	pi.registerTool({
		name: "firecrawl_crawl",
		label: "Firecrawl Crawl",
		description: "Crawl a site or section with Firecrawl.",
		promptSnippet: "Crawl a site or docs section with Firecrawl when multiple related pages need to be gathered.",
		promptGuidelines: [
			"Use firecrawl_crawl when the user wants a docs section or website area explored across multiple pages.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Root URL to crawl" }),
		}),
		renderCall(args, theme, context) {
			return renderLine(`${theme.fg("toolTitle", theme.bold("firecrawl_crawl"))} ${theme.fg("accent", oneLine(args.url, 110))}`, theme, context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return renderLine(theme.fg("warning", "firecrawl_crawl running…"), theme, context);
			const errorResult = renderErrorResult(result, theme, context);
			if (errorResult) return errorResult;
			const d = result.details || {};
			let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "firecrawl_crawl")} ${theme.fg("accent", oneLine(context.args?.url, 100))}`;
			if (typeof d.pages === "number") text += ` · ${d.pages} pages`;
			if (expanded) {
				if (d.mergedPath) text += `\nMerged: ${theme.fg("dim", d.mergedPath)}`;
				if (d.jsonPath) text += `\nJSON: ${theme.fg("dim", d.jsonPath)}`;
			}
			return renderLine(text, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!config.firecrawlApiKey) throw new Error("Firecrawl is not configured. Set FIRECRAWL_API_KEY or ~/.pi/web-smart-fetch.json");
			const { crawlWithFirecrawl, getFirecrawlClient } = await loadFirecrawlModule();
			const client = await getFirecrawlClient(config);
			if (!client) throw new Error("Firecrawl is not configured. Set FIRECRAWL_API_KEY or ~/.pi/web-smart-fetch.json");
			onUpdate?.({ content: [{ type: "text", text: "Crawling with Firecrawl..." }] });
			const result: any = await crawlWithFirecrawl(client, params.url, 20);
			const dir = makeArtifactDir(config.crawlDir, "crawl", params.url);
			const jsonPath = saveJson(join(dir, "result.json"), result);
			const docs = result?.data || [];
			const merged = docs
				.slice(0, 10)
				.map((d: any) => `## ${d.metadata?.title || d.metadata?.sourceURL || d.url || "Document"}\n${d.metadata?.sourceURL || d.url || ""}\n\n${truncate(d.markdown || "", 4000)}`)
				.join("\n\n");
			const mergedPath = saveText(join(dir, "merged.md"), merged);
			return {
				content: [{ type: "text", text: `Firecrawl crawl for: ${params.url}\n\nPages captured: ${docs.length}\n\n${merged}\n\nSaved full JSON: ${jsonPath}\nMerged markdown: ${mergedPath}` }],
				details: { jsonPath, mergedPath, pages: docs.length },
			};
		},
	});
}
