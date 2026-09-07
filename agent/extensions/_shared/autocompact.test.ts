import assert from "node:assert/strict";
import test from "node:test";
import { registerAutocompact } from "./autocompact.ts";

function setup() {
	let command: any;
	let start: any;
	const notifications: string[] = [];
	const blocked = registerAutocompact({
		on(name: string, handler: any) {
			assert.equal(name, "session_start");
			start = handler;
		},
		registerCommand(name: string, definition: any) {
			assert.equal(name, "autocompact");
			command = definition.handler;
		},
	} as any);
	return {
		blocked: (reason: "manual" | "threshold" | "overflow") => blocked({ reason }),
		run: (args = "") => command(args, { ui: { notify: (text: string) => notifications.push(text) } }),
		start: () => start(),
		notifications,
	};
}

test("toggle blocks both automatic reasons, but not manual compaction", async () => {
	const state = setup();
	assert.equal(state.blocked("threshold"), false);
	await state.run();
	assert.equal(state.blocked("threshold"), true);
	assert.equal(state.blocked("overflow"), true);
	assert.equal(state.blocked("manual"), false);
	await state.run();
	assert.equal(state.blocked("threshold"), false);
	assert.equal(state.blocked("overflow"), false);
});

test("explicit values are idempotent; invalid arguments leave state unchanged", async () => {
	const state = setup();
	await state.run("off");
	await state.run("off");
	assert.equal(state.blocked("threshold"), true);
	await state.run("on off");
	assert.equal(state.blocked("threshold"), true);
	assert.equal(state.notifications.at(-1), "Usage: /autocompact [on|off]");
	await state.run(" ON ");
	await state.run("on");
	assert.equal(state.blocked("threshold"), false);
});

test("state resets on session start and does not affect another instance", async () => {
	const state = setup();
	await state.run("off");
	assert.equal(setup().blocked("threshold"), false);
	state.start();
	assert.equal(state.blocked("threshold"), false);
});
