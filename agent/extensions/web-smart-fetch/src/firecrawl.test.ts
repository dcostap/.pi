import assert from "node:assert/strict";
import test from "node:test";
import { crawlWithFirecrawl, searchWithFirecrawl } from "./firecrawl.ts";

const client = {
	apiKey: "test-key",
	apiUrl: "https://firecrawl.test",
	maxResponseBytes: 1024 * 1024,
	minimumCredits: 100,
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
	globalThis.fetch = async () => jsonResponse([
		{ success: true, data: { remainingCredits: 500, planCredits: 1500 } },
		{ id: "job-failed" },
		{ status: "failed", error: "upstream crawler failed" },
	][request++]);
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
	globalThis.fetch = async () => jsonResponse([
		{ success: true, data: { remainingCredits: 500, planCredits: 1500 } },
		{ id: "job-running" },
		{ status: "scraping" },
	][Math.min(request++, 2)]);
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

test("Firecrawl checks credits before a billable request", async () => {
	const originalFetch = globalThis.fetch;
	const paths: string[] = [];
	globalThis.fetch = async (input) => {
		paths.push(new URL(String(input)).pathname);
		return paths.length === 1
			? jsonResponse({ success: true, data: { remainingCredits: 500, planCredits: 1500 } })
			: jsonResponse({ success: true, data: { web: [] } });
	};
	try {
		await searchWithFirecrawl(client, "safe search");
		assert.deepEqual(paths, ["/v2/team/credit-usage", "/v2/search"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Firecrawl blocks billable requests at the minimum reserve", async () => {
	const originalFetch = globalThis.fetch;
	const paths: string[] = [];
	globalThis.fetch = async (input) => {
		paths.push(new URL(String(input)).pathname);
		return jsonResponse({ success: true, data: { remainingCredits: 100, planCredits: 1500 } });
	};
	try {
		await assert.rejects(searchWithFirecrawl(client, "blocked search"), /minimum reserve is 100/);
		assert.deepEqual(paths, ["/v2/team/credit-usage"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Firecrawl fails closed when the balance cannot be verified", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
	};
	try {
		await assert.rejects(searchWithFirecrawl(client, "blocked search"), /No billable request was sent/);
		assert.equal(requests, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
