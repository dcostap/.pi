import assert from "node:assert/strict";
import test from "node:test";
import { classifyContentQuality, selectContentOutput } from "./content-policy.ts";

test("ordinary content is accepted without model judgment", () => {
	assert.equal(classifyContentQuality("Useful article body", []).quality, "OK");
});

test("soft signals are ambiguous but challenge signals are deterministically weak", () => {
	assert.equal(classifyContentQuality("Short page", ["too-short"]).quality, "AMBIGUOUS");
	assert.equal(classifyContentQuality("Checking your browser", ["checking your browser"]).quality, "WEAK");
});

test("ordinary pages return their extracted content directly", () => {
	const output = selectContentOutput({
		content: "Complete extracted page",
		quality: "OK",
		summaryThresholdChars: 18_000,
		previewChars: 5_000,
	});
	assert.deepEqual(output, { kind: "content", text: "Complete extracted page", truncated: false });
});

test("oversized pages prefer summaries and fall back to bounded previews", () => {
	const content = "x".repeat(20_000);
	assert.equal(
		selectContentOutput({
			content,
			quality: "OK",
			tldr: "Page summary",
			summaryThresholdChars: 18_000,
			previewChars: 5_000,
		}).kind,
		"summary",
	);

	const fallback = selectContentOutput({
		content,
		quality: "OK",
		summaryThresholdChars: 18_000,
		previewChars: 5_000,
	});
	assert.equal(fallback.kind, "preview");
	assert.ok(fallback.text.length < 5_100);
});

test("focused answers take precedence over raw content", () => {
	const output = selectContentOutput({
		content: "Complete extracted page",
		quality: "OK",
		prompt: "What is the answer?",
		answer: "42",
		summaryThresholdChars: 18_000,
		previewChars: 5_000,
	});
	assert.deepEqual(output, { kind: "answer", text: "42", truncated: false });
});

test("focused-answer failure returns all bounded ordinary content", () => {
	const content = "x".repeat(10_000);
	const output = selectContentOutput({
		content,
		quality: "OK",
		prompt: "What is the answer?",
		summaryThresholdChars: 18_000,
		previewChars: 5_000,
	});
	assert.equal(output.kind, "content");
	assert.equal(output.text, content);
	assert.equal(output.truncated, false);
});

test("short weak previews are not reported as truncated", () => {
	const output = selectContentOutput({
		content: "Access denied",
		quality: "WEAK",
		summaryThresholdChars: 18_000,
		previewChars: 5_000,
	});
	assert.equal(output.kind, "preview");
	assert.equal(output.truncated, false);
});
