import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "cache-cold-warning";
const COLD_AFTER_MS = 50 * 60_000;
const CHECK_INTERVAL_MS = 30_000;

function formatIdle(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lastAssistantTime(ctx: ExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; timestamp?: string; message?: { role?: string } };
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.timestamp) {
			const time = Date.parse(entry.timestamp);
			if (Number.isFinite(time)) return time;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let lastResponseAt: number | undefined;
	let running = false;
	let shown = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	function update(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const cold = !running && lastResponseAt !== undefined && Date.now() - lastResponseAt >= COLD_AFTER_MS;
		if (!cold) {
			if (shown) ctx.ui.setWidget(WIDGET_KEY, undefined);
			shown = false;
			return;
		}
		// Re-set each tick so the idle time stays current.
		const text = `⚠ cache's probably cold (idle ${formatIdle(Date.now() - lastResponseAt!)})`;
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			render: (width: number) => [theme.fg("warning", truncateToWidth(text, width))],
			invalidate: () => {},
		}));
		shown = true;
	}

	pi.on("session_start", (_event, ctx) => {
		lastResponseAt = lastAssistantTime(ctx);
		running = false;
		update(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => update(ctx), CHECK_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("agent_start", (_event, ctx) => {
		running = true;
		update(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		running = false;
		lastResponseAt = Date.now();
		update(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (shown && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		shown = false;
	});
}
