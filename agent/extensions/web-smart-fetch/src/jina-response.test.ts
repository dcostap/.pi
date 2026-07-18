import assert from "node:assert/strict";
import test from "node:test";
import { parseJinaTargetMetadata } from "./jina-response.ts";

test("uses embedded target status and URL instead of Jina proxy metadata", () => {
	const metadata = parseJinaTargetMetadata(
		"URL Source: https://example.com/missing\n\nWarning: Target URL returned error 404: Not Found",
		"https://example.com/original",
		200,
	);
	assert.deepEqual(metadata, { status: 404, finalUrl: "https://example.com/missing" });
});

test("falls back to proxy status and requested target when no envelope metadata exists", () => {
	assert.deepEqual(parseJinaTargetMetadata("Plain content", "https://example.com", 200), {
		status: 200,
		finalUrl: "https://example.com",
	});
});
