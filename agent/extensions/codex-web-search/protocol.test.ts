import assert from "node:assert/strict";
import test from "node:test";
import {
	accountIdFromToken,
	buildCodexSearchRequest,
	getHeader,
	resolveCodexSearchUrl,
	selectSearchTools,
} from "./protocol.ts";

test("derives the Codex search endpoint", () => {
	assert.equal(
		resolveCodexSearchUrl("https://chatgpt.com/backend-api/codex"),
		"https://chatgpt.com/backend-api/codex/alpha/search",
	);
	assert.equal(
		resolveCodexSearchUrl("https://proxy.example/api/codex/responses"),
		"https://proxy.example/api/codex/alpha/search",
	);
});

test("builds a bounded direct search request", () => {
	assert.deepEqual(
		buildCodexSearchRequest({
			search_query: [{ q: "Pi agent", recency: 7, domains: ["pi.dev"] }],
			response_length: "short",
			settings: { search_context_size: "low" },
		}, "session-1", "gpt-5.6-luna", 1200),
		{
			id: "session-1",
			model: "gpt-5.6-luna",
			commands: {
				search_query: [{ q: "Pi agent", recency: 7, domains: ["pi.dev"] }],
				response_length: "short",
			},
			settings: {
				search_context_size: "low",
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: 1200,
		},
	);
});

test("rejects an empty operation", () => {
	assert.throws(() => buildCodexSearchRequest({}, "session-1", "gpt-5.6-luna"));
});

test("reads case-insensitive auth headers", () => {
	assert.equal(getHeader({ "ChatGPT-Account-ID": "account-1" }, "chatgpt-account-id"), "account-1");
});

test("extracts an account id from a JWT", () => {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-2" },
	})).toString("base64url");
	assert.equal(accountIdFromToken(`header.${payload}.signature`), "account-2");
});

test("uses only Codex for search on Codex models", () => {
	assert.deepEqual(
		selectSearchTools(["fetch_url", "firecrawl_search", "firecrawl_crawl"], true, false),
		{
			activeTools: ["fetch_url", "firecrawl_crawl", "codex_web_search"],
			firecrawlSearchDisplaced: true,
		},
	);
});

test("restores Firecrawl search after leaving a Codex model", () => {
	assert.deepEqual(
		selectSearchTools(["fetch_url", "firecrawl_crawl", "codex_web_search"], false, true),
		{
			activeTools: ["fetch_url", "firecrawl_crawl", "firecrawl_search"],
			firecrawlSearchDisplaced: false,
		},
	);
});

test("does not enable Firecrawl when it was already disabled", () => {
	assert.deepEqual(
		selectSearchTools(["fetch_url", "codex_web_search"], false, false),
		{
			activeTools: ["fetch_url"],
			firecrawlSearchDisplaced: false,
		},
	);
});
