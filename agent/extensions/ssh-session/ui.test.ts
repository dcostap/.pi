import { describe, expect, test } from "bun:test";
import { renderSshCall, renderSshResult } from "./ui.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("SSH tool chat rendering", () => {
	test("links local transfer paths and output files, but not identical remote paths", () => {
		const previous = process.env.PI_TEST_HYPERLINKS;
		process.env.PI_TEST_HYPERLINKS = "1";
		try {
			const cwd = resolve("ssh-test");
			const path = resolve(cwd, "file #1.txt");
			const url = pathToFileURL(path).href;
			const call = renderSshCall({ action: "upload", local_path: "@file #1.txt", remote_path: "/srv/file.txt" }, theme, false, undefined, cwd).render(200).join("\n");
			expect(call).toContain(`\x1b]8;;${url}\x1b\\@file #1.txt\x1b]8;;\x1b\\ → /srv/file.txt`);
			const spaced = renderSshCall({ action: "download", local_path: "file  with  spaces.txt", remote_path: "/srv/file.txt" }, theme, false, undefined, cwd).render(200).join("\n");
			expect(spaced).toContain(pathToFileURL(resolve(cwd, "file  with  spaces.txt")).href);
			const result = renderSshResult({ content: [{ type: "text", text: `Local: ${path}\nRemote: ${path}\nFull output saved to: ${path}` }], details: { localPath: path, fullOutputPath: path } }, { expanded: true, isPartial: false }, theme, undefined, false, cwd).render(200).join("\n");
			expect(result).toContain(`Local: \x1b]8;;${url}\x1b\\${path}`);
			expect(result).toContain(`Remote: ${path}\n`);
			expect(result).toContain(`Full output saved to: \x1b]8;;${url}\x1b\\${path}`);
		} finally {
			if (previous === undefined) delete process.env.PI_TEST_HYPERLINKS;
			else process.env.PI_TEST_HYPERLINKS = previous;
		}
	});

	test("shows the selected connection in collapsed calls and results", () => {
		const call = renderSshCall({ action: "exec", session_id: "ssh-2", command: "hostname" }, theme, false).render(200).join("\n");
		expect(call).toContain("on ssh-2");
		const result = renderSshResult({ content: [{ type: "text", text: "Session: ssh-2 (root@hero-1)\nhero-1\nExit code: 0 (root)" }] }, { expanded: false, isPartial: false }, theme).render(200).join("\n");
		expect(result).toContain("Session: ssh-2 (root@hero-1)");
	});

	test("shows ordinary multiline commands without requiring expansion", () => {
		const command = "echo one\necho two\necho three";
		const collapsed = renderSshCall({ action: "exec", command, cwd: "/tmp" }, theme, false);

		expect(collapsed.render(200).join("\n")).toContain("echo three");
		expect(collapsed.render(200).join("\n")).not.toContain("more lines");
	});

	test("summarizes only unusually long commands and shows them when expanded", () => {
		const command = Array.from({ length: 15 }, (_, index) => `echo ${index + 1}`).join("\n");
		const collapsed = renderSshCall({ action: "exec", command }, theme, false);
		const expanded = renderSshCall({ action: "exec", command }, theme, true);
		const collapsedText = collapsed.render(200).join("\n");

		expect(collapsedText).toContain("echo 12");
		expect(collapsedText).toContain("# … 3 more lines");
		expect(collapsedText).not.toContain("echo 13");
		expect(expanded.render(200).join("\n")).toContain("echo 15");
	});

	test("shows upload and download paths without shell decoration", () => {
		const upload = renderSshCall({
			action: "upload",
			local_path: "build/app.jar",
			remote_path: "/srv/stage/app.jar",
			overwrite: true,
		}, theme, false).render(200).join("\n");
		const download = renderSshCall({
			action: "download",
			local_path: "logs/server.log",
			remote_path: "/var/log/server.log",
		}, theme, false).render(200).join("\n");

		expect(upload).toContain("build/app.jar → /srv/stage/app.jar");
		expect(upload).toContain("overwrite");
		expect(upload).not.toContain("$ ");
		expect(download).toContain("/var/log/server.log → logs/server.log");
	});

	test("uses Ctrl+O expansion for long tool results while preserving the dump path", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		lines.push("[Output truncated: showing the latest output. Full output saved to: C:/temp/full.log]");
		lines.push("Use read with offset/limit or grep on that file to inspect the complete output.");
		lines.push("Exit code: 0");
		const result = { content: [{ type: "text", text: lines.join("\n") }], details: {} };

		const collapsed = renderSshResult(result, { expanded: false, isPartial: false }, theme);
		const expanded = renderSshResult(result, { expanded: true, isPartial: false }, theme);
		const collapsedText = collapsed.render(200).join("\n");
		const expandedText = expanded.render(200).join("\n");

		expect(collapsedText).toContain("ctrl+o to expand");
		expect(collapsedText).toContain("C:/temp/full.log");
		expect(collapsedText).not.toContain("line 20");
		expect(expandedText).toContain("line 20");
	});
});
