import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Monkey patch for Pi: a message that starts a turn waits for a manual compaction to end.
//
// pi.sendMessage(..., { triggerTurn: true }) steers into a running turn. During a manual
// /compact (or a branch summary) no turn runs, so Pi starts a new turn next to the
// compaction. prompt() refuses that case; sendCustomMessage does not check it. Anvil
// steering that arrives during /compact then cancels the compaction. This patch holds the
// message until the session is idle, then lets Pi deliver it as usual.

const PATCHED = Symbol.for("steer-after-compaction:patched");

export default function steerAfterCompaction(pi: ExtensionAPI) {
	const proto = (piCodingAgent as any).AgentSession?.prototype;
	const original = proto?.sendCustomMessage;
	if (typeof original !== "function") {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("steer-after-compaction: Pi changed AgentSession.sendCustomMessage. The patch is off.", "warning");
		});
		return;
	}
	// The patched method outlives an extension reload.
	if (original[PATCHED]) return;

	const patched = async function (this: any, message: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }) {
		if (options?.triggerTurn && options.deliverAs !== "nextTurn") {
			// Another /compact can start before the message is sent, so check again after each wait.
			while (this.isCompacting && !this.isStreaming) await this.waitForIdle();
		}
		return original.call(this, message, options);
	};
	(patched as any)[PATCHED] = true;
	proto.sendCustomMessage = patched;
}
