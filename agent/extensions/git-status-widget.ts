import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitStatusWidgetRuntime } from "./git-status-widget/runtime.ts";

let runtime: GitStatusWidgetRuntime | undefined;

const WORKTREE_MUTATING_TOOLS = new Set([
	"apply_patch",
	"bash",
	"bash_bg_start",
	"bash_bg_wait",
	"edit",
	"write",
]);

export function shouldRefreshAfterTool(toolName: string) {
	return WORKTREE_MUTATING_TOOLS.has(toolName);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		runtime?.dispose();
		runtime = undefined;
		if (!ctx.hasUI) return;
		runtime = new GitStatusWidgetRuntime(ctx);
		runtime.start();
	});

	pi.on("agent_start", () => {
		runtime?.onAgentStart();
	});

	pi.on("input", () => {
		runtime?.onUserInput();
		return { action: "continue" };
	});

	pi.on("tool_execution_end", (event) => {
		if (shouldRefreshAfterTool(event.toolName)) runtime?.onWorkingTreeMutation();
	});

	pi.on("agent_settled", () => {
		runtime?.onAgentSettled();
	});

	pi.on("session_shutdown", () => {
		runtime?.dispose();
		runtime = undefined;
	});

	pi.registerCommand("git-status-refresh", {
		description: "Refresh the Git status widget now",
		handler: async (_args, ctx) => {
			if (!runtime) {
				if (ctx.hasUI) ctx.ui.notify("Git status widget is unavailable in this mode", "warning");
				return;
			}
			const queued = runtime.refreshNow();
			if (ctx.hasUI) {
				ctx.ui.notify(
					queued ? "Git status refresh queued" : "Git status widget is disabled",
					queued ? "info" : "warning",
				);
			}
		},
	});

	pi.registerCommand("git-status-widget", {
		description: "Enable, disable, or toggle the Git status widget",
		handler: async (args, ctx) => {
			if (!runtime) {
				if (ctx.hasUI) ctx.ui.notify("Git status widget is unavailable in this mode", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action && action !== "on" && action !== "off" && action !== "toggle") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /git-status-widget [on|off|toggle]", "warning");
				return;
			}
			const enabled = action === "on" ? true : action === "off" ? false : !runtime.isEnabled();
			runtime.setEnabled(enabled);
			if (ctx.hasUI) ctx.ui.notify(`Git status widget ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
