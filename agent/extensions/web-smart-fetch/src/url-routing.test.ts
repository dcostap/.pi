import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubUrl } from "./github.ts";
import { normalizeUrl, resolveUrl, sanitizeUrlCandidate, urlDedupeKey } from "./url-routing.ts";

test("sanitizes Markdown wrappers and unbalanced punctuation", () => {
	assert.equal(sanitizeUrlCandidate("<https://example.com/page>"), "https://example.com/page");
	assert.equal(sanitizeUrlCandidate("https://example.com/page)."), "https://example.com/page");
	assert.equal(sanitizeUrlCandidate("https://example.com/Foo_(bar)"), "https://example.com/Foo_(bar)");
});

test("normalizes protocol, fragments, default ports, and trailing slashes", () => {
	assert.equal(normalizeUrl("example.com/page/#section"), "https://example.com/page/");
	assert.equal(normalizeUrl("https://example.com:443/page/"), "https://example.com/page/");
	assert.equal(urlDedupeKey("https://example.com/page#one"), urlDedupeKey("https://example.com/page/#two"));
});

test("preserves valid terminal punctuation in transport URLs", () => {
	assert.equal(normalizeUrl("https://example.com/search?q=what!"), "https://example.com/search?q=what!");
	assert.equal(normalizeUrl("https://example.com/a."), "https://example.com/a.");
});

test("rejects unsupported protocols", () => {
	assert.throws(() => normalizeUrl("file:///etc/passwd"), /Unsupported URL protocol/);
	assert.throws(() => normalizeUrl("javascript:alert(1)"), /Unsupported URL protocol/);
	assert.throws(() => normalizeUrl("https://alice:secret@example.com/private"), /credentials are not allowed/);
});

test("rewrites supported Apple documentation to Sosumi without forwarding query values", () => {
	const result = resolveUrl("https://developer.apple.com/documentation/swift/string?api_key=secret#overview");
	assert.equal(result.adapterId, "apple-docs-sosumi");
	assert.equal(result.canonicalUrl, "https://developer.apple.com/documentation/swift/string?api_key=secret");
	assert.equal(result.fetchUrl, "https://sosumi.ai/documentation/swift/string");
	assert.equal(result.expectedContentType, "text/markdown");
	assert.equal(result.rewritten, true);
});

test("classifies existing GitHub and YouTube special handling", () => {
	assert.equal(resolveUrl("github.com/owner/repo").handler, "github");
	assert.ok(parseGitHubUrl("https://www.github.com/owner/repo"));
	assert.equal(resolveUrl("https://youtu.be/example").handler, "youtube");
});
