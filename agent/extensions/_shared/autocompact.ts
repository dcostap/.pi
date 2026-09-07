import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export function registerAutocompact(pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", () => {
		enabled = true;
	});

	pi.registerCommand("autocompact", {
		description: "Toggle automatic compaction for this session; optional on or off",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value !== "" && value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /autocompact [on|off]", "error");
				return;
			}
			enabled = value === "" ? !enabled : value === "on";
			ctx.ui.notify(`Automatic compaction: ${enabled ? "on" : "off"} for this session.`, "info");
		},
	});

	return (event: Pick<SessionBeforeCompactEvent, "reason">) =>
		!enabled && event.reason !== "manual";
}
