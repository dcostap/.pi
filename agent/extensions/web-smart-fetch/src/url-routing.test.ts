import assert from "node:assert/strict";
import test from "node:test";
import { checkoutDirName, formatCheckoutPreview, formatGitHubCommitPreview, formatListing, GITHUB_GIT_TIMEOUT_MS, parseGitHubUrl, parseLsTree } from "./github.ts";
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

test("parses git ls-tree output, including paths with spaces and tabs", () => {
	const output = [
		"040000 tree aaa\tapps",
		"100644 blob bbb\tapps/my file.ts",
		"100644 blob ccc\ta\tb.txt",
		"160000 commit ddd\tvendor",
		"",
	].join("\0");
	assert.deepEqual(parseLsTree(output), [
		{ type: "tree", path: "apps" },
		{ type: "blob", path: "apps/my file.ts" },
		{ type: "blob", path: "a\tb.txt" },
		{ type: "commit", path: "vendor" },
	]);
});

test("names one checkout folder per ref, also for refs with slashes", () => {
	assert.equal(checkoutDirName("main"), "main");
	assert.equal(checkoutDirName("release/1.0"), "release%2F1.0");
});

test("lists two levels below a path, or one level when two are too many", () => {
	const entries = [
		{ type: "tree", path: "apps" },
		{ type: "tree", path: "apps/server" },
		{ type: "blob", path: "apps/server/index.ts" },
		{ type: "blob", path: "package.json" },
	];
	assert.deepEqual(formatListing(entries, ""), ["apps/", "apps/server/", "package.json"]);
	assert.deepEqual(formatListing(entries, "apps"), ["server/", "server/index.ts"]);

	const wide = Array.from({ length: 150 }, (_, i) => [
		{ type: "tree", path: `d${i}` },
		{ type: "blob", path: `d${i}/f.ts` },
	]).flat();
	const listing = formatListing(wide, "");
	assert.equal(listing.length, 150);
	assert.ok(listing.every((line) => !line.includes("/f.ts")));
});

test("tells the agent to explore a full checkout locally", () => {
	const preview = formatCheckoutPreview({
		owner: "owner",
		repo: "repo",
		ref: "main",
		sha: "0123456789abcdef",
		relPath: "",
		dir: "C:/cache/owner/repo/main",
		localPath: "C:/cache/owner/repo/main",
		fileCount: 1234,
		sparse: false,
		sparsePaths: [],
		listing: ["apps/", "package.json"],
	});
	assert.match(preview, /Local checkout: C:\/cache\/owner\/repo\/main/);
	assert.match(preview, /Checkout: full, 1,234 files/);
	assert.match(preview, /whole repository is on disk/);
	assert.match(preview, /Listing of \/:\napps\/\npackage\.json/);
	assert.doesNotMatch(preview, /\n\n\n/);
});

test("tells the agent how to add folders to a sparse checkout", () => {
	const preview = formatCheckoutPreview({
		owner: "owner",
		repo: "repo",
		ref: "main",
		sha: "0123456789abcdef",
		relPath: "apps/server",
		dir: "C:/cache/owner/repo/main",
		localPath: "C:/cache/owner/repo/main/apps/server",
		fileCount: 90000,
		sparse: true,
		sparseReason: "the files total 2,000 MB",
		sparsePaths: ["apps/server"],
		fileListPath: "C:/cache/owner/repo/main.files.txt",
		listing: ["index.ts"],
	});
	assert.match(preview, /Path: apps\/server/);
	assert.match(preview, /Checkout: sparse, 90,000 files \(the files total 2,000 MB\)/);
	assert.match(preview, /On disk: root files, apps\/server/);
	assert.match(preview, /https:\/\/github\.com\/owner\/repo\/tree\/main\/<folder>/);
	assert.match(preview, /main\.files\.txt/);
});
