import type FirecrawlDefault from "@mendable/firecrawl-js";
import type { ExtensionConfig } from "./config.ts";

type FirecrawlClient = FirecrawlDefault;
const FIRECRAWL_TIMEOUT_MS = 60_000;

// Firecrawl's SDK default HTTP timeout is 300_000ms. Keep Pi tools responsive by
// capping long network/scrape waits at one minute.
type FirecrawlConstructor = new (options?: { apiKey?: string | null; apiUrl?: string | null; timeoutMs?: number }) => FirecrawlClient;

// Cache object avoids TDZ issues when jiti re-enters the module during evaluation.
const _fcCache: { sdk: unknown; loading: Promise<unknown> | null } = { sdk: undefined, loading: null };

async function loadFirecrawlSdk(): Promise<unknown> {
	if (_fcCache.sdk) return _fcCache.sdk;
	if (_fcCache.loading) return _fcCache.loading;
	_fcCache.loading = import("@mendable/firecrawl-js");
	try {
		_fcCache.sdk = await _fcCache.loading;
		return _fcCache.sdk;
	} catch (error) {
		_fcCache.loading = null;
		throw error;
	}
}

async function getFirecrawlConstructor(): Promise<FirecrawlConstructor> {
	const sdk = await loadFirecrawlSdk();
	const seen = new Set<unknown>();
	const candidates: unknown[] = [sdk];

	// @mendable/firecrawl-js has changed its ESM/CJS export shape across versions,
	// and pi's TS runtime may resolve either the ESM or CJS conditional export.
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

	const details = [
		`sdkType=${typeof sdk}`,
		sdk && typeof sdk === "object" ? `top=[${Object.keys(sdk as Record<string, unknown>).join(",")}]` : "",
		`sdk.default=${(sdk as any)?.default ? typeof (sdk as any).default : "missing"}`,
		(sdk as any)?.default && typeof (sdk as any).default === "object" ? `default=[${Object.keys((sdk as any).default).join(",")}]` : "",
	].filter(Boolean).join(" ");
	throw new Error(`Firecrawl SDK failed to load: missing Firecrawl constructor export (${details})`);
}

export async function getFirecrawlClient(config: ExtensionConfig): Promise<FirecrawlClient | undefined> {
	if (!config.firecrawlApiKey) return undefined;
	const Firecrawl = await getFirecrawlConstructor();
	return new Firecrawl({ apiKey: config.firecrawlApiKey, timeoutMs: FIRECRAWL_TIMEOUT_MS });
}

export async function scrapeWithFirecrawl(client: FirecrawlClient, url: string) {
	return await client.scrape(url, {
		formats: ["markdown", "html", "links"],
		timeout: FIRECRAWL_TIMEOUT_MS,
	});
}

export async function questionWithFirecrawl(client: FirecrawlClient, url: string, question: string) {
	return await client.scrape(url, {
		formats: [{ type: "question", question }, "markdown", "html", "links"],
		timeout: FIRECRAWL_TIMEOUT_MS,
	});
}

export async function searchWithFirecrawl(client: FirecrawlClient, query: string, limit = 5) {
	return await client.search(query, { limit });
}

export async function crawlWithFirecrawl(client: FirecrawlClient, url: string, limit = 20) {
	return await client.crawl(url, {
		limit,
		timeout: FIRECRAWL_TIMEOUT_MS / 1000,
		scrapeOptions: { formats: ["markdown"], timeout: FIRECRAWL_TIMEOUT_MS },
	});
}
