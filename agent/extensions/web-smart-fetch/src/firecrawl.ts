import Firecrawl from "@mendable/firecrawl-js";
import type { ExtensionConfig } from "./config.ts";

export function getFirecrawlClient(config: ExtensionConfig): Firecrawl | undefined {
	if (!config.firecrawlApiKey) return undefined;
	return new Firecrawl({ apiKey: config.firecrawlApiKey });
}

export async function scrapeWithFirecrawl(client: Firecrawl, url: string) {
	return await client.scrape(url, {
		formats: ["markdown", "html", "links"],
	});
}

export async function questionWithFirecrawl(client: Firecrawl, url: string, question: string) {
	return await client.scrape(url, {
		formats: [{ type: "question", question }, "markdown", "html", "links"],
	});
}

export async function searchWithFirecrawl(client: Firecrawl, query: string, limit = 5) {
	return await client.search(query, { limit });
}

export async function crawlWithFirecrawl(client: Firecrawl, url: string, limit = 20) {
	return await client.crawl(url, {
		limit,
		scrapeOptions: { formats: ["markdown"] },
	});
}
