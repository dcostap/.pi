import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";

const EXTENSION_ID = "autopilot-mode";
const AUTOPILOT_PROMPT =
	"I'm out of office, so I can't answer personally. Thus, you shan't stop your work unless strictly necessary. Your duty is now to continue on your own, following the same task requirements, and picking the next best task if needed. However, if you are TRULY done with all your tasks, output only one phrase: I'm completely done.";
const DONE_MESSAGES = new Set(["I'm completely done", "I'm completely done."]);
const AUTOPILOT_BANNER = " AUTOPILOT MODE ENABLED ";
const AUTOPILOT_COUNTER_PREFIX = " SENT MESSAGES COUNTER: ";
const REFILL_DELAYS_MS = [10, 40, 100, 200, 400] as const;
const SCHEDULE_POLL_MS = 50;

function getLastAssistantText(messages: unknown[] | undefined): string | undefined {
	if (!Array.isArray(messages)) return undefined;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

		const text = message.content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text!.trim())
			.filter(Boolean)
			.join("\n")
			.trim();

		if (text) return text;
	}

	return undefined;
}

function isDoneMessage(text: string | undefined): boolean {
	return text !== undefined && DONE_MESSAGES.has(text.trim());
}

export default function autopilotMode(pi: ExtensionAPI): void {
	let enabled = false;
	let autopilotSentCount = 0;
	let pendingSendTimer: ReturnType<typeof setTimeout> | undefined;

	function updateIndicatorWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setWidget(EXTENSION_ID, undefined);
			return;
		}

		ctx.ui.setWidget(
			EXTENSION_ID,
			(_tui, theme) => ({
				render(width: number): string[] {
					const counterText =
						autopilotSentCount > 0
							? `///${AUTOPILOT_COUNTER_PREFIX}${autopilotSentCount} `
							: "";
					const bannerText = `${AUTOPILOT_BANNER}${counterText}`;

					if (width <= bannerText.length) {
						return [theme.fg("success", truncateToWidth(bannerText.trim(), width))];
					}

					const left = Math.floor((width - bannerText.length) / 2);
					const right = Math.max(0, width - bannerText.length - left);
					return [theme.fg("success", `${"=".repeat(left)}${bannerText}${"=".repeat(right)}`)];
				},
				invalidate(): void {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function getPromptText(ctx: ExtensionContext): string {
		const text = ctx.hasUI ? ctx.ui.getEditorText() : "";
		return text.length > 0 ? text : AUTOPILOT_PROMPT;
	}

	function replacePrompt(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorText(text);
	}

	function refillPromptWhenCleared(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;

		for (const delayMs of REFILL_DELAYS_MS) {
			setTimeout(() => {
				if (!enabled || !ctx.hasUI) return;
				if (ctx.ui.getEditorText().length === 0) {
					ctx.ui.setEditorText(text);
				}
			}, delayMs);
		}
	}

	function clearPendingSend(): void {
		if (pendingSendTimer) {
			clearTimeout(pendingSendTimer);
			pendingSendTimer = undefined;
		}
	}

	function sendCurrentPrompt(ctx: ExtensionContext): void {
		const text = getPromptText(ctx);
		pi.sendUserMessage(text);
		autopilotSentCount += 1;
		updateIndicatorWidget(ctx);
		refillPromptWhenCleared(ctx, text);
	}

	function scheduleNextPrompt(ctx: ExtensionContext): void {
		clearPendingSend();

		const tick = () => {
			if (!enabled) {
				pendingSendTimer = undefined;
				return;
			}
			if (ctx.hasPendingMessages() || !ctx.isIdle()) {
				pendingSendTimer = setTimeout(tick, SCHEDULE_POLL_MS);
				return;
			}

			pendingSendTimer = undefined;
			sendCurrentPrompt(ctx);
		};

		pendingSendTimer = setTimeout(tick, 0);
	}

	function enableAutopilot(ctx: ExtensionContext): void {
		if (enabled) return;

		enabled = true;
		autopilotSentCount = 0;
		updateIndicatorWidget(ctx);
		replacePrompt(ctx, AUTOPILOT_PROMPT);
		ctx.ui.notify("Autopilot mode enabled.", "info");
	}

	function disableAutopilot(ctx: ExtensionContext, message?: string): void {
		enabled = false;
		clearPendingSend();
		updateIndicatorWidget(ctx);
		if (message) ctx.ui.notify(message, "info");
	}

	pi.registerCommand("autopilot", {
		description: "Toggle autopilot mode",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "status") {
				ctx.ui.notify(enabled ? "Autopilot mode is on." : "Autopilot mode is off.", "info");
				return;
			}

			if (command === "on") {
				enableAutopilot(ctx);
				return;
			}

			if (command === "off") {
				disableAutopilot(ctx, "Autopilot mode disabled.");
				return;
			}

			if (command && command !== "toggle") {
				ctx.ui.notify("Usage: /autopilot [on|off|toggle|status]", "warning");
				return;
			}

			if (enabled) disableAutopilot(ctx, "Autopilot mode disabled.");
			else enableAutopilot(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Toggle autopilot mode",
		handler: async (ctx) => {
			if (enabled) disableAutopilot(ctx, "Autopilot mode disabled.");
			else enableAutopilot(ctx);
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) return;

		const lastAssistantText = getLastAssistantText(event.messages as unknown[]);
		if (isDoneMessage(lastAssistantText)) {
			disableAutopilot(ctx, "Autopilot finished: assistant reported completion.");
			return;
		}

		scheduleNextPrompt(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		autopilotSentCount = 0;
		clearPendingSend();
		updateIndicatorWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearPendingSend();
		ctx.ui.setWidget(EXTENSION_ID, undefined);
	});
}
