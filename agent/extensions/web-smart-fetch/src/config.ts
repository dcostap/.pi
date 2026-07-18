import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExtensionConfig = {
	firecrawlApiKey?: string;
	summaryThresholdChars: number;
	previewChars: number;
	maxConcurrentFetches: number;
	maxTextResponseBytes: number;
	maxPdfResponseBytes: number;
	maxFirecrawlResponseBytes: number;
	baseDir: string;
	githubCacheDir: string;
	fetchesDir: string;
	crawlDir: string;
};

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const baseDir = join(localAppData, "pi-web-smart-fetch");
const configPath = join(homedir(), ".pi", "web-smart-fetch.json");
const legacyConfigPath = join(homedir(), ".pi", "firecrawl-smart-fetch.json");

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

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
		summaryThresholdChars: boundedInteger(
			process.env.WEB_SMART_FETCH_SUMMARY_THRESHOLD_CHARS ?? fileConfig.summaryThresholdChars,
			18_000,
			1_000,
			40_000,
		),
		previewChars: boundedInteger(
			process.env.WEB_SMART_FETCH_PREVIEW_CHARS ?? fileConfig.previewChars,
			5_000,
			500,
			20_000,
		),
		maxConcurrentFetches: boundedInteger(
			process.env.WEB_SMART_FETCH_MAX_CONCURRENCY ?? fileConfig.maxConcurrentFetches,
			4,
			1,
			16,
		),
		maxTextResponseBytes: boundedInteger(
			process.env.WEB_SMART_FETCH_MAX_TEXT_BYTES ?? fileConfig.maxTextResponseBytes,
			5 * 1024 * 1024,
			64 * 1024,
			50 * 1024 * 1024,
		),
		maxPdfResponseBytes: boundedInteger(
			process.env.WEB_SMART_FETCH_MAX_PDF_BYTES ?? fileConfig.maxPdfResponseBytes,
			25 * 1024 * 1024,
			1024 * 1024,
			100 * 1024 * 1024,
		),
		maxFirecrawlResponseBytes: boundedInteger(
			process.env.WEB_SMART_FETCH_MAX_FIRECRAWL_BYTES ?? fileConfig.maxFirecrawlResponseBytes,
			20 * 1024 * 1024,
			1024 * 1024,
			100 * 1024 * 1024,
		),
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
