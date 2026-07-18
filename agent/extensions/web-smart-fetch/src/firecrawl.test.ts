import assert from "node:assert/strict";
import test from "node:test";
import { crawlWithFirecrawl } from "./firecrawl.ts";

const client = {
	apiKey: "test-key",
	apiUrl: "https://firecrawl.test",
	maxResponseBytes: 1024 * 1024,
};

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("failed Firecrawl crawl jobs throw instead of looking successful", async () => {
	const originalFetch = globalThis.fetch;
	let request = 0;
	globalThis.fetch = async () => jsonResponse(request++ === 0
		? { id: "job-failed" }
		: { status: "failed", error: "upstream crawler failed" });
	try {
		await assert.rejects(
			crawlWithFirecrawl(client, "https://example.com"),
			/Firecrawl crawl failed.*upstream crawler failed/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Firecrawl crawl polling delay honors cancellation", async () => {
	const originalFetch = globalThis.fetch;
	let request = 0;
	globalThis.fetch = async () => jsonResponse(request++ === 0
		? { id: "job-running" }
		: { status: "scraping" });
	const controller = new AbortController();
	const reason = new Error("test cancellation");
	setTimeout(() => controller.abort(reason), 10);
	try {
		await assert.rejects(
			crawlWithFirecrawl(client, "https://example.com", 20, controller.signal),
			/test cancellation/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
