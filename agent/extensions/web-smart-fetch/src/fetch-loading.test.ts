import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

for (const moduleCache of [false, true]) {
	test(`parallel first fetches wait for imports (moduleCache=${moduleCache})`, async () => {
		const jiti = createJiti(import.meta.url, {
			moduleCache,
			tryNative: false,
			virtualModules: {
				"@earendil-works/pi-coding-agent": { getAgentDir: () => "unused" },
				"@earendil-works/pi-tui": {},
				"typebox": {
					Type: {
						Object: (value: unknown) => value,
						Optional: (value: unknown) => value,
						String: () => ({}),
					},
				},
				"./config.ts": { loadConfig: () => ({ maxConcurrentFetches: 4 }) },
			},
		});
		const factory = await jiti.import<(pi: any) => void>(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			{ default: true },
		);
		let fetchTool: any;
		factory({ registerTool: (tool: any) => { fetchTool = tool; } });
		assert.equal(fetchTool.name, "fetch_url");

		// An empty URL stops before network access. Every caller must reach URL validation,
		// not invoke a partially initialized module with an undefined resolveUrl import.
		const fetch = () => fetchTool.execute("test", { url: "" }, undefined, undefined, {});
		const results = await Promise.allSettled(Array.from({ length: 4 }, fetch));
		for (const result of results) {
			assert.equal(result.status, "rejected");
			if (result.status === "rejected") assert.equal(result.reason.message, "URL is required");
		}
		await assert.rejects(fetch(), { message: "URL is required" });
	});
}
