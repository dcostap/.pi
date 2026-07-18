import assert from "node:assert/strict";
import test from "node:test";
import { assessWeakness, resolveBodyContentType } from "./quality-signals.ts";

test("HTTP errors are escalation signals even when the error page has content", () => {
	const reasons = assessWeakness("A long and detailed not-found page".repeat(100), undefined, { status: 404 });
	assert.ok(reasons.includes("http-status-404"));
});

test("empty and challenge responses are escalation signals", () => {
	assert.ok(assessWeakness("").includes("empty-content"));
	assert.ok(assessWeakness("Checking your browser before accessing the site").includes("checking your browser"));
	assert.ok(
		assessWeakness("Please wait", "<html><title>Just a moment...</title><body>Please wait</body></html>")
			.includes("just a moment"),
	);
});

test("short API payloads remain valid while short HTML is ambiguous", () => {
	assert.equal(assessWeakness('{"ok":true}', undefined, { apiLike: true }).includes("too-short"), false);
	assert.ok(assessWeakness("Short article", "<main>Short article</main>").includes("html-too-short"));
});

test("expected Markdown is only a hint when the body is actually HTML", () => {
	assert.equal(resolveBodyContentType("", "# Swift String", "text/markdown"), "text/markdown");
	assert.equal(
		resolveBodyContentType("", "<!doctype html><html><body>Error</body></html>", "text/markdown"),
		"text/html",
	);
});
