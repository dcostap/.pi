import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitStatusWidget, { shouldRefreshAfterTool } from "../git-status-widget.ts";

describe("extension wiring", () => {
	test("registers the lifecycle hooks and user commands", () => {
		const events: string[] = [];
		const commands: string[] = [];
		const api = {
			on: (event: string) => events.push(event),
			registerCommand: (command: string) => commands.push(command),
		} as unknown as ExtensionAPI;

		gitStatusWidget(api);
		expect(events).toEqual([
			"session_start",
			"agent_start",
			"input",
			"tool_execution_end",
			"agent_settled",
			"session_shutdown",
		]);
		expect(commands).toEqual(["git-status-refresh", "git-status-widget"]);
	});

	test("refreshes for mutating tools but not ordinary read-only tools", () => {
		for (const tool of ["write", "edit", "apply_patch", "bash", "bash_bg_start", "bash_bg_wait"]) {
			expect(shouldRefreshAfterTool(tool)).toBe(true);
		}
		for (const tool of ["read", "everything_search", "fetch_url", "chrome_cdp"]) {
			expect(shouldRefreshAfterTool(tool)).toBe(false);
		}
	});
});
