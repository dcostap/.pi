import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyLimiter } from "./concurrency-limiter.ts";

test("queues work beyond the configured concurrency", async () => {
	const limiter = new ConcurrencyLimiter(1);
	const releaseFirst = await limiter.acquire();
	let secondStarted = false;
	const second = limiter.acquire().then((release) => {
		secondStarted = true;
		return release;
	});
	await Promise.resolve();
	assert.equal(secondStarted, false);
	assert.equal(limiter.pending, 1);
	releaseFirst();
	const releaseSecond = await second;
	assert.equal(secondStarted, true);
	releaseSecond();
});

test("removes aborted waiters from the queue", async () => {
	const limiter = new ConcurrencyLimiter(1);
	const release = await limiter.acquire();
	const controller = new AbortController();
	const waiting = limiter.acquire(controller.signal);
	controller.abort();
	await assert.rejects(waiting, /aborted/i);
	assert.equal(limiter.pending, 0);
	release();
});
