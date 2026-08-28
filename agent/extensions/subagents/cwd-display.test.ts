import { describe, expect, test } from "bun:test";
import path from "node:path";
import { customCwdDisplay } from "./cwd-display.ts";

describe("subagent CWD display", () => {
	test("omits the parent session CWD", () => {
		const cwd = path.resolve("project");
		expect(customCwdDisplay(cwd, cwd)).toBe("");
	});

	test("shows a compact relative custom CWD", () => {
		const parent = path.resolve("projects", "main");
		const child = path.resolve("projects", "worker-one");
		expect(customCwdDisplay(child, parent)).toBe(`cwd ${path.join("..", "worker-one")}`);
	});

	test("omits unknown paths", () => {
		expect(customCwdDisplay(undefined, path.resolve("project"))).toBe("");
		expect(customCwdDisplay(path.resolve("project"), undefined)).toBe("");
	});
});
