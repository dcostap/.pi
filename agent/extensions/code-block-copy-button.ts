import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { installCodeBlockCopyButton } from "./_shared/code-block-copy-button.ts";

const WIDGET_KEY = "code-block-copy-button";

export default function codeBlockCopyButton(pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	let requestRender = () => {};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Only a widget factory receives the TUI. The widget draws nothing.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			requestRender = () => tui.requestRender();
			return { render: () => [], invalidate() {} };
		});
		restore?.();
		restore = installCodeBlockCopyButton(Markdown, copyToClipboard, () => requestRender());
		if (!restore) ctx.ui.notify("Code block copy button is not compatible with this Pi version.", "warning");
	});
	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
		requestRender = () => {};
	});
}
