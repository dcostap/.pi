import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hyperlink, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

const schema = (..._args: unknown[]) => ({});
mock.module("typebox", () => ({ Type: new Proxy({}, { get: () => schema }) }));
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: schema }));
mock.module("@earendil-works/pi-coding-agent", () => ({ DEFAULT_MAX_BYTES: 50000, DEFAULT_MAX_LINES: 2000, formatSize: String, truncateHead: schema }));
mock.module("../web-smart-fetch/src/config.ts", () => ({ loadConfig: () => ({ firecrawlApiKey: "test", firecrawlMinimumCredits: 1, maxConcurrentFetches: 2 }) }));
mock.module("../web-smart-fetch/src/fetch-url.ts", () => ({ fetchUrl: schema }));
mock.module("../web-smart-fetch/src/firecrawl.ts", () => ({
	getFirecrawlClient: async () => ({}), getFirecrawlCreditUsage: async () => ({ remainingCredits: 100 }),
	crawlWithFirecrawl: schema, searchWithFirecrawl: schema,
}));
const { default: webExtension } = await import("../web-smart-fetch/src/index.ts");
const { default: searchExtension } = await import("../codex-web-search/index.ts");
const { default: everythingExtension } = await import("../everything-search.ts");

const cwd = resolve("link-test-project");
const path = resolve(cwd, "saved file #1.txt");
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const options = { expanded: true, isPartial: false };
const context = { cwd, args: {}, isError: false };
const rendered = (component: any) => component.render(1000).join("\n");
const link = (value: string) => hyperlink(value, pathToFileURL(value).href);
const previousEverythingFlag = process.env.EVERYTHING_SEARCH_EXTENSION_ENABLED;

beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: true }));
afterEach(() => {
	resetCapabilitiesCache();
	if (previousEverythingFlag === undefined) delete process.env.EVERYTHING_SEARCH_EXTENSION_ENABLED;
	else process.env.EVERYTHING_SEARCH_EXTENSION_ENABLED = previousEverythingFlag;
});

async function toolsFor(extension: Function): Promise<Map<string, any>> {
	const tools = new Map<string, any>();
	await extension({ on() {}, registerCommand() {}, registerMarkdownTransformer() {}, registerTool(tool: any) { tools.set(tool.name, tool); } });
	return tools;
}

describe("custom renderer file links", () => {
	test("links fetch cache paths and saved files in both result layouts", async () => {
		const tools = await toolsFor(webExtension);
		for (const method of ["github", "direct"]) {
			const result = { content: [{ type: "text", text: "File: example.ts\ncontent" }], details: { method, localPath: path, artifactDir: cwd, files: { raw: path } } };
			const text = rendered(tools.get("fetch_url").renderResult(result, options, theme, context));
			expect(text).toContain(link(path));
			expect(text).toContain(link(cwd));
		}
	});

	test("links crawl and search artifacts and honors disabled URL hyperlinks", async () => {
		const tools = await toolsFor(webExtension);
		const searchResult = { content: [], details: { files: { json: path }, topResults: [{ title: "Example", url: "https://example.com" }] } };
		expect(rendered(tools.get("firecrawl_search").renderResult(searchResult, options, theme, context))).toContain(link(path));
		const crawlResult = { content: [], details: { mergedPath: path, jsonPath: path } };
		expect(rendered(tools.get("firecrawl_crawl").renderResult(crawlResult, options, theme, context))).toContain(link(path));
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		expect(rendered(tools.get("firecrawl_search").renderResult(searchResult, options, theme, context))).not.toContain("\x1b]8;");
	});

	test("links the full Codex result", async () => {
		const tools = await toolsFor(searchExtension);
		const result = { content: [{ type: "text", text: "Search results" }], details: { artifactPath: path } };
		expect(rendered(tools.get("codex_web_search").renderResult(result, options, theme, context))).toContain(link(path));
	});

	test("links Everything results and dump files without linking metadata", async () => {
		process.env.EVERYTHING_SEARCH_EXTENSION_ENABLED = "1";
		const tools = await toolsFor(everythingExtension);
		const tool = tools.get("everything_search");
		const dump = { content: [{ type: "text", text: `Found 3 results. Dumped to ${path}` }], details: { output_path: path } };
		expect(rendered(tool.renderResult(dump, options, theme, context))).toContain(link(path));
		const itemPath = `${cwd}\\file.txt`;
		const results = { content: [{ type: "text", text: `Found 1 result\n${itemPath}  32 B` }], details: { results: [{ path: cwd, name: "file.txt" }] } };
		expect(rendered(tool.renderResult(results, options, theme, context))).toContain(`${hyperlink(itemPath, pathToFileURL(itemPath).href)}  32 B`);
	});
});
