import assert from "node:assert/strict";
import test from "node:test";
import { handleGitHubUrl, buildPartialCloneArgs, decodeGitHubContentsText, formatGitHubCommitPreview, formatGitHubContentsPreview, GITHUB_GIT_TIMEOUT_MS, parseGitHubUrl } from "./github.ts";
import { normalizeUrl, resolveUrl, sanitizeUrlCandidate, thirdPartyFallbackBlockReason, urlDedupeKey } from "./url-routing.ts";

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
	assert.equal(normalizeUrl("https://example.com/search?next=foo)"), "https://example.com/search?next=foo)");
	assert.equal(normalizeUrl("https://example.com/search?next=foo]"), "https://example.com/search?next=foo]");
	assert.equal(normalizeUrl("https://example.com/a."), "https://example.com/a.");
});

test("blocks credential-bearing URLs from automatic third-party fallback", () => {
	assert.match(thirdPartyFallbackBlockReason("https://example.com/file?X-Amz-Signature=secret") || "", /X-Amz-Signature/i);
	assert.match(thirdPartyFallbackBlockReason("https://example.com/file?access_token=secret") || "", /access_token/i);
	assert.equal(thirdPartyFallbackBlockReason("https://example.com/search?q=fonts&page=2"), undefined);
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
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/commit/94e2812449eb6c3503fded952b3749f958b76af4"), {
		owner: "owner",
		repo: "repo",
		mode: "commit",
		ref: "94e2812449eb6c3503fded952b3749f958b76af4",
	});
	assert.equal(parseGitHubUrl("https://github.com/owner/repo/commit/not-a-sha"), undefined);
	assert.equal(parseGitHubUrl("https://github.com/owner/repo/tree/main/safe%2F..%2Fescape"), undefined);
	assert.equal(resolveUrl("https://youtu.be/example").handler, "youtube");
});

test("routes GitHub raw files directly without the repository cache", () => {
	const raw = resolveUrl("https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf");
	assert.equal(raw.handler, "direct");
	assert.equal(raw.adapterId, "github-raw");
	assert.equal(raw.fetchUrl, raw.canonicalUrl);

	const blob = resolveUrl("https://github.com/google/fonts/blob/main/ofl/silkscreen/OFL.txt?plain=1");
	assert.equal(blob.handler, "direct");
	assert.equal(blob.adapterId, "github-blob-raw");
	assert.equal(blob.fetchUrl, "https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/OFL.txt");
});

test("uses a five-minute shallow, blob-filtered, sparse GitHub clone", () => {
	const args = buildPartialCloneArgs("google", "fonts", "C:/cache/fonts.tmp");
	assert.equal(GITHUB_GIT_TIMEOUT_MS, 300_000);
	assert.ok(args.includes("--depth=1"));
	assert.ok(args.includes("--filter=blob:none"));
	assert.ok(args.includes("--sparse"));
	assert.ok(args.includes("--no-checkout"));
});

test("formats GitHub directory listings without claiming a local checkout", () => {
	const preview = formatGitHubContentsPreview("google", "fonts", "main", "ofl/silkscreen", [
		{ type: "file", name: "Silkscreen-Regular.ttf", size: 1234 },
		{ type: "dir", name: "docs", size: 0 },
	]);
	assert.match(preview, /GitHub Contents API \(no repository clone\)/);
	assert.match(preview, /Silkscreen-Regular\.ttf/);
	assert.doesNotMatch(preview, /Local path:/);
});

test("formats GitHub commits with metadata and the actual patch", () => {
	const preview = formatGitHubCommitPreview("owner", "repo", {
		sha: "abcdef1234567",
		html_url: "https://github.com/owner/repo/commit/abcdef1234567",
		author: { login: "alice" },
		commit: {
			message: "Fix the race\n\nTake the snapshot after the swap.",
			author: { name: "Alice", date: "2026-07-29T12:00:00Z" },
		},
		parents: [{ sha: "1234567890abc" }],
		stats: { additions: 2, deletions: 1 },
		files: [{ filename: "src/write.rs", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }],
	}, "https://github.com/owner/repo/commit/abcdef1234567");
	assert.match(preview, /Fix the race/);
	assert.match(preview, /Parent: 1234567890abc/);
	assert.match(preview, /src\/write\.rs/);
	assert.match(preview, /@@ -1 \+1 @@\n-old\n\+new/);
});

test("labels truncated or unavailable GitHub API file content", () => {
	const longText = "x".repeat(20_100);
	const truncated = formatGitHubContentsPreview("owner", "repo", "main", "large.txt", {
		type: "file",
		size: longText.length,
		encoding: "base64",
		content: Buffer.from(longText).toString("base64"),
	});
	assert.match(truncated, /preview truncated at 20,000 characters/);

	const unavailable = formatGitHubContentsPreview("owner", "repo", "main", "huge.bin", {
		type: "file",
		size: 2_000_000,
		download_url: "https://raw.githubusercontent.com/owner/repo/main/huge.bin",
	});
	assert.match(unavailable, /Content unavailable/);
	assert.match(unavailable, /Download URL:/);
});

test("decodes GitHub API file content for focused answers", () => {
	const source = "module intellij.platform.editor";
	const contents = {
		type: "file",
		encoding: "base64",
		content: Buffer.from(source).toString("base64"),
	};
	assert.equal(decodeGitHubContentsText(contents), source);
	assert.equal(decodeGitHubContentsText({ type: "file", content: source }), source);
});

test("returns decoded GitHub tree file text separately from its preview", async () => {
	const source = "intellij.platform.editor\nintellij.platform.core\n";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		type: "file",
		name: "module.iml",
		size: Buffer.byteLength(source),
		encoding: "base64",
		content: Buffer.from(source).toString("base64"),
	}), { status: 200, headers: { "content-type": "application/json" } });

	try {
		const result = await handleGitHubUrl({ maxTextResponseBytes: 1024 } as any, "https://github.com/owner/repo/tree/main/module.iml");
		assert.equal(result.content, source);
		assert.equal(result.contentKind, "text");
		assert.equal(result.contentTruncated, false);
		assert.match(result.preview, /File: module\.iml/);
		assert.match(result.preview, /Source: GitHub Contents API/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
