import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hyperlink, resetCapabilitiesCache, setCapabilities, Text, visibleWidth } from "@earendil-works/pi-tui";
import { linkFile, linkFilePaths, linkUrl } from "./file-links.ts";

beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: true }));
afterEach(() => resetCapabilitiesCache());
const cwd = resolve("test-project");

describe("terminal file links", () => {
	test("encodes the full target while preserving the styled label", () => {
		const path = "folder/file #1.ts";
		expect(linkFile("\x1b[31mshort…\x1b[39m", path, cwd)).toBe(
			hyperlink("\x1b[31mshort…\x1b[39m", pathToFileURL(resolve(cwd, path)).href),
		);
	});

	test("uses the supplied session directory, not the process directory", () => {
		expect(linkFile("file", "file.ts", resolve(cwd, "other"))).toContain(pathToFileURL(resolve(cwd, "other/file.ts")).href);
	});

	test("links only known local paths and handles repeated and overlapping paths", () => {
		const short = resolve(cwd, "log.txt");
		const long = `${short}.old`;
		const remote = "/srv/remote.txt";
		const text = `${short}\n${long}\n${remote}\n${short}`;
		const linked = linkFilePaths(text, [short, long, short], cwd);
		expect(linked).toBe(`${linkFile(short, short, cwd)}\n${linkFile(long, long, cwd)}\n${remote}\n${linkFile(short, short, cwd)}`);
	});

	test("does not emit links when the terminal disables hyperlinks", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		expect(linkFile("file", "file.ts", cwd)).toBe("file");
		expect(linkFilePaths("file.ts", ["file.ts"], cwd)).toBe("file.ts");
		expect(linkUrl("web", "https://example.com")).toBe("web");
	});

	test("keeps links closed across wrapping and padding", () => {
		const linked = linkFile("a long file path with spaces.ts", "file.ts", cwd);
		const lines = new Text(`${linked} counts`, 1, 0).render(16);
		const open = `\x1b]8;;${pathToFileURL(resolve(cwd, "file.ts")).href}\x1b\\`;
		const close = "\x1b]8;;\x1b\\";
		expect(lines.filter((line) => line.includes(open)).length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
			if (line.includes(open)) expect(line.lastIndexOf(close)).toBeGreaterThan(line.lastIndexOf(open));
		}
	});
});
