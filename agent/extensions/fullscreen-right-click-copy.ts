import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installRightClickCopy } from "./_shared/fullscreen-right-click-copy.ts";

export default function fullscreenRightClickCopy(pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		restore?.();
		restore = installRightClickCopy(TuiAltScreen.prototype);
		if (!restore) ctx.ui.notify("Right-click copy is not compatible with this Pi version.", "warning");
	});
	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}
