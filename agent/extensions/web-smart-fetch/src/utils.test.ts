import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeArtifactDir } from "./utils.ts";

test("artifact directories are unique for identical concurrent-style requests", () => {
	const root = mkdtempSync(join(tmpdir(), "web-smart-fetch-utils-"));
	try {
		const first = makeArtifactDir(root, "fetch", "https://example.com/same");
		const second = makeArtifactDir(root, "fetch", "https://example.com/same");
		assert.notEqual(first, second);
		assert.match(first, /fetch_/);
		assert.match(second, /fetch_/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
