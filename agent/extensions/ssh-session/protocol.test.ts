import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRemoteCommand,
	parseSshConfig,
	possibleMarkerSuffixLength,
	sanitizeTerminalText,
	shellQuote,
} from "./protocol.ts";

test("parses ssh -G output", () => {
	assert.deepEqual(
		parseSshConfig("box", "host box\nuser dario\nhostname 10.0.0.4\nport 2222\n"),
		{ requested: "box", hostName: "10.0.0.4", user: "dario", port: 2222 },
	);
});

test("quotes POSIX shell values", () => {
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
	assert.equal(
		buildRemoteCommand("printf '%s' ok", "/tmp/a b"),
		`cd -- '/tmp/a b' && exec /bin/sh -lc 'printf '"'"'%s'"'"' ok'`,
	);
});

test("sanitizes terminal control sequences", () => {
	assert.equal(sanitizeTerminalText("ok\x1b]52;c;secret\x07\x1b[31mred\x1b[0m"), "okred");
});

test("retains only a possible split marker suffix", () => {
	assert.equal(possibleMarkerSuffixLength("hello __PI", "__PI_READY__"), 4);
	assert.equal(possibleMarkerSuffixLength("hello", "__PI_READY__"), 0);
});

