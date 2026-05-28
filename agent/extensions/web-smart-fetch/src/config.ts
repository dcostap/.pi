import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExtensionConfig = {
	firecrawlApiKey?: string;
	summaryThresholdChars: number;
	previewChars: number;
	baseDir: string;
	githubCacheDir: string;
	fetchesDir: string;
	crawlDir: string;
};

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const baseDir = join(localAppData, "pi-web-smart-fetch");
const configPath = join(homedir(), ".pi", "web-smart-fetch.json");
const legacyConfigPath = join(homedir(), ".pi", "firecrawl-smart-fetch.json");

export function loadConfig(): ExtensionConfig {
	let fileConfig: Record<string, unknown> = {};
	const readableConfigPath = existsSync(configPath) ? configPath : legacyConfigPath;
	if (existsSync(readableConfigPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(readableConfigPath, "utf8"));
		} catch {
			// ignore malformed local config
		}
	}

	const cfg: ExtensionConfig = {
		firecrawlApiKey:
			(process.env.FIRECRAWL_API_KEY || fileConfig.firecrawlApiKey?.toString()) ?? undefined,
		summaryThresholdChars: 18000,
		previewChars: 5000,
		baseDir,
		githubCacheDir: join(baseDir, "github-cache"),
		fetchesDir: join(baseDir, "fetches"),
		crawlDir: join(baseDir, "crawls"),
	};

	for (const dir of [cfg.baseDir, cfg.githubCacheDir, cfg.fetchesDir, cfg.crawlDir]) {
		mkdirSync(dir, { recursive: true });
	}

	return cfg;
}
