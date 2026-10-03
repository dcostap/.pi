import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TranscriptReader } from "./reader.ts";
import { readRenderedTranscript } from "./snapshot.ts";

export default function (pi: ExtensionAPI) {
	let active = false;
	let closeActive: (() => void) | undefined;

	pi.registerShortcut("f2", {
		description: "Select and copy transcript text; F2 returns to the prompt",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || active) return;
			active = true;
			try {
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					if (tui.hasOverlay()) {
						done();
						return { render: () => [], invalidate() {} };
					}
					const snapshot = readRenderedTranscript(tui);
					if (!snapshot) {
						ctx.ui.notify("Transcript navigation needs Pi 1.0 fullscreen mode.", "warning");
						done();
						return { render: () => [], invalidate() {} };
					}
					closeActive = done;
					return new TranscriptReader(snapshot, tui, done, copyToClipboard,
						(text) => theme.fg("muted", text));
				}, {
					overlay: true,
					overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
				});
			} finally {
				active = false;
				closeActive = undefined;
			}
		},
	});

	pi.on("session_shutdown", () => closeActive?.());
}
