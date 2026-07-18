import assert from "node:assert/strict";
import test from "node:test";
import { readResponseBuffer, readResponseText, ResponseSizeLimitError } from "./response-body.ts";

test("rejects a declared Content-Length before reading", async () => {
	const response = new Response("small", { headers: { "Content-Length": "100" } });
	await assert.rejects(() => readResponseBuffer(response, 10, "fixture"), ResponseSizeLimitError);
});

test("enforces the limit while streaming when Content-Length is absent", async () => {
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(8));
				controller.enqueue(new Uint8Array(8));
				controller.close();
			},
		}),
	);
	await assert.rejects(() => readResponseBuffer(response, 10, "fixture"), ResponseSizeLimitError);
});

test("returns bounded text unchanged", async () => {
	assert.equal(await readResponseText(new Response("hello"), 10), "hello");
});
