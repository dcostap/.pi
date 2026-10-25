import { test, expect, mock } from "bun:test";

let config: Record<string, any> = {};
mock.module("../web-smart-fetch/src/config.ts", () => ({ loadConfig: () => ({ ...config }) }));
mock.module("@earendil-works/pi-tui", () => ({
  Text: class {}, getCapabilities: () => ({ hyperlinks: false }), hyperlink: (text: string) => text,
}));
mock.module("typebox", () => ({
  Type: { Object: (value: unknown) => value, String: (value: unknown) => value, Optional: (value: unknown) => value },
}));
const { default: register } = await import("../web-smart-fetch/src/index.ts");

function activate(apiKey?: string) {
  config = {
    firecrawlApiKey: apiKey,
    firecrawlMinimumCredits: 100,
    maxFirecrawlResponseBytes: 1024 * 1024,
    maxConcurrentFetches: 2,
  };
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const result = register({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any);
  return { result, tools, commands };
}

test("configured tools register immediately without network requests", () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("No startup network request is allowed"); }) as any;
  try {
    const { result, tools, commands } = activate("test-key");
    expect(result).toBeUndefined();
    expect([...tools.keys()]).toEqual(["fetch_url", "firecrawl_search", "firecrawl_crawl"]);
    expect(commands.has("firecrawl-credits")).toBe(true);
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("without a key, only fetch_url registers", () => {
  const { result, tools, commands } = activate();
  expect(result).toBeUndefined();
  expect([...tools.keys()]).toEqual(["fetch_url"]);
  expect(commands.size).toBe(0);
});

for (const toolName of ["firecrawl_search", "firecrawl_crawl"]) {
  for (const status of [200, 401, 503]) {
    test(`${toolName} sends no paid request when the first credit check fails (${status})`, async () => {
      const original = globalThis.fetch;
      const paths: string[] = [];
      globalThis.fetch = (async (input: string) => {
        paths.push(new URL(input).pathname);
        return new Response(JSON.stringify(status === 200
          ? { success: true, data: { remainingCredits: 100, planCredits: 1500 } }
          : { error: "unavailable" }), { status });
      }) as any;
      try {
        const { tools } = activate("test-key");
        await expect(tools.get(toolName).execute("test", { query: "test", url: "https://example.com" }))
          .rejects.toThrow("No billable request was sent");
        expect(paths).toEqual(["/v2/team/credit-usage"]);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
}
