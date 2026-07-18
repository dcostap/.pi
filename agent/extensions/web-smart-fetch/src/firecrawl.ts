import type { ExtensionConfig } from "./config.ts";
import { readResponseText } from "./response-body.ts";

const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/$/, "");
const FIRECRAWL_TIMEOUT_MS = 60_000;

type FirecrawlClient = {
	apiKey: string;
	apiUrl: string;
	maxResponseBytes: number;
};

async function requestFirecrawl(
	client: FirecrawlClient,
	path: string,
	init?: RequestInit,
	parentSignal?: AbortSignal,
	timeoutMs = FIRECRAWL_TIMEOUT_MS,
): Promise<any> {
	const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
	const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(`${client.apiUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${client.apiKey}`,
			"Content-Type": "application/json",
			...(init?.headers || {}),
		},
		signal,
	});
	const text = await readResponseText(response, client.maxResponseBytes, `Firecrawl response (${path})`, signal);
	let body: any;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { error: text };
	}
	if (!response.ok || body?.success === false) {
		const message = body?.error || body?.message || `${response.status} ${response.statusText}`;
		throw new Error(`Firecrawl request failed (${path}): ${message}`);
	}
	return body;
}

function remainingMs(deadline: number, jobId?: string): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new Error(`Firecrawl crawl timed out after ${FIRECRAWL_TIMEOUT_MS / 1000}s${jobId ? ` (job ${jobId})` : ""}`);
	}
	return remaining;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Firecrawl crawl aborted"));
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, ms);
		const onAbort = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Firecrawl crawl aborted"));
		};
		function cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
		function done() {
			cleanup();
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function getFirecrawlClient(config: ExtensionConfig): Promise<FirecrawlClient | undefined> {
	if (!config.firecrawlApiKey) return undefined;
	return {
		apiKey: config.firecrawlApiKey,
		apiUrl: FIRECRAWL_API_URL,
		maxResponseBytes: config.maxFirecrawlResponseBytes,
	};
}

export async function scrapeWithFirecrawl(client: FirecrawlClient, url: string, signal?: AbortSignal) {
	const body = await requestFirecrawl(client, "/v2/scrape", {
		method: "POST",
		body: JSON.stringify({
			url,
			formats: ["markdown", "html", "links"],
			timeout: FIRECRAWL_TIMEOUT_MS,
		}),
	}, signal);
	return body?.data || {};
}

export async function searchWithFirecrawl(client: FirecrawlClient, query: string, limit = 5, signal?: AbortSignal) {
	const body = await requestFirecrawl(client, "/v2/search", {
		method: "POST",
		body: JSON.stringify({ query, limit }),
	}, signal);
	return body?.data || {};
}

export async function crawlWithFirecrawl(client: FirecrawlClient, url: string, limit = 20, signal?: AbortSignal) {
	const deadline = Date.now() + FIRECRAWL_TIMEOUT_MS;
	const started = await requestFirecrawl(client, "/v2/crawl", {
		method: "POST",
		body: JSON.stringify({
			url,
			limit,
			scrapeOptions: { formats: ["markdown"], timeout: FIRECRAWL_TIMEOUT_MS },
		}),
	}, signal, remainingMs(deadline));
	const id = started?.id;
	if (!id) throw new Error("Firecrawl crawl did not return a job id");

	while (true) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Firecrawl crawl aborted");
		const status = await requestFirecrawl(
			client,
			`/v2/crawl/${encodeURIComponent(id)}`,
			undefined,
			signal,
			remainingMs(deadline, id),
		);
		const state = String(status?.status || "").toLowerCase();
		if (state === "completed") return status;
		if (state === "failed" || state === "cancelled") {
			const reason = status?.error || status?.message || "no reason provided";
			throw new Error(`Firecrawl crawl ${state} (job ${id}): ${reason}`);
		}
		await abortableDelay(Math.min(2_000, remainingMs(deadline, id)), signal);
	}
}
