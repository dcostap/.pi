import * as FirecrawlSdk from "@mendable/firecrawl-js";
import type FirecrawlDefault from "@mendable/firecrawl-js";
import type { ExtensionConfig } from "./config.ts";

type FirecrawlClient = FirecrawlDefault;
type FirecrawlConstructor = new (options?: { apiKey?: string | null; apiUrl?: string | null }) => FirecrawlClient;

function getFirecrawlConstructor(): FirecrawlConstructor {
	const sdk: any = FirecrawlSdk;
	const ctor = sdk?.default ?? sdk?.Firecrawl ?? sdk;
	if (typeof ctor !== "function") {
		throw new Error("Firecrawl SDK failed to load: missing Firecrawl constructor export");
	}
	return ctor as FirecrawlConstructor;
}

export function getFirecrawlClient(config: ExtensionConfig): FirecrawlClient | undefined {
	if (!config.firecrawlApiKey) return undefined;
	const Firecrawl = getFirecrawlConstructor();
	return new Firecrawl({ apiKey: config.firecrawlApiKey });
}

export async function scrapeWithFirecrawl(client: FirecrawlClient, url: string) {
	return await client.scrape(url, {
		formats: ["markdown", "html", "links"],
	});
}

export async function questionWithFirecrawl(client: FirecrawlClient, url: string, question: string) {
	return await client.scrape(url, {
		formats: [{ type: "question", question }, "markdown", "html", "links"],
	});
}

export async function searchWithFirecrawl(client: FirecrawlClient, query: string, limit = 5) {
	return await client.search(query, { limit });
}

export async function crawlWithFirecrawl(client: FirecrawlClient, url: string, limit = 20) {
	return await client.crawl(url, {
		limit,
		scrapeOptions: { formats: ["markdown"] },
	});
}
