import * as FirecrawlSdk from "@mendable/firecrawl-js";
import type FirecrawlDefault from "@mendable/firecrawl-js";
import type { ExtensionConfig } from "./config.ts";

type FirecrawlClient = FirecrawlDefault;
type FirecrawlConstructor = new (options?: { apiKey?: string | null; apiUrl?: string | null }) => FirecrawlClient;

function getFirecrawlConstructor(): FirecrawlConstructor {
	const seen = new Set<unknown>();
	const candidates: unknown[] = [FirecrawlSdk];

	// @mendable/firecrawl-js has changed its ESM/CJS export shape across versions,
	// and pi/tsx may resolve either the `import` or `default` conditional export.
	// Walk the common wrapper shapes instead of assuming one exact namespace shape.
	for (let i = 0; i < candidates.length; i++) {
		const candidate: any = candidates[i];
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (typeof candidate === "function") return candidate as FirecrawlConstructor;
		if (typeof candidate === "object") {
			candidates.push(candidate.Firecrawl, candidate.FirecrawlClient, candidate.default, candidate.default?.Firecrawl, candidate.default?.default);
		}
	}

	const sdk: any = FirecrawlSdk;
	const keys = [
		`top=[${Object.keys(sdk || {}).join(",")}]`,
		`sdk.default=${sdk?.default ? typeof sdk.default : "missing"}`,
		sdk?.default && typeof sdk.default === "object" ? `default=[${Object.keys(sdk.default).join(",")}]` : "",
	].filter(Boolean).join(" ");
	throw new Error(`Firecrawl SDK failed to load: missing Firecrawl constructor export (${keys})`);
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
