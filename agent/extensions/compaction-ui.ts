import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Monkey patches for Pi's compaction UI. Pi 1.3.0 maps this import to its bundled
// InteractiveMode, so the patches reach the running UI. They use private members. If a
// Pi update changes them, each patch falls back to Pi's own UI and shows a warning once:
// a missing method is not patched, and an error in a patch is caught before Pi's
// original runs.
//
// 1. The cost notice adds cache reads to "tokens billed". A summary written from the
//    prompt cache (claude-bridge) then reads like a full-price 288k-token request. The
//    count shows only new tokens, and the cache reads are listed after it.
// 2. The "Compacting..." spinner shows the model and thinking level of the summary.
//    Pi shows the spinner before session_before_compact, so it starts with the
//    session's model (Pi's default). compaction-model.ts emits "compaction:model"
//    when it summarizes with another model.

const PATCHED = Symbol.for("compaction-ui:patched");

type CompactionModel = { model?: { provider: string; id: string; reasoning?: boolean }; thinkingLevel?: string };

// Shared across extension reloads: the patched methods outlive this extension instance.
const state = ((globalThis as any)[PATCHED] ??= { warned: new Set<string>(), pending: [] }) as {
	indicator?: any;
	label?: string;
	notify?: (message: string) => void;
	warned: Set<string>;
	pending: string[];
};

/** Show each problem once. Before the first session starts, hold it until then. */
function warn(problem: string, fallback = "Pi's own UI is used instead"): void {
	if (state.warned.has(problem)) return;
	state.warned.add(problem);
	const message = `compaction-ui: ${problem}. ${fallback}. Update extensions/compaction-ui.ts for this Pi version.`;
	console.error(message);
	if (state.notify) state.notify(message);
	else state.pending.push(message);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function patch(proto: any, name: string, wrap: (original: any) => (this: any, ...args: any[]) => any): void {
	const original = proto[name];
	if (typeof original !== "function") return warn(`InteractiveMode.${name} no longer exists`);
	if (original[PATCHED]) return;
	const patched: any = wrap(original);
	patched[PATCHED] = true;
	proto[name] = patched;
}

export default function compactionUi(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		state.notify = (message) => {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// A stale ctx after a reload or session switch; the next session_start replaces it.
			}
		};
		for (const message of state.pending.splice(0)) state.notify(message);
	});

	const proto = (piCodingAgent as any).InteractiveMode?.prototype;
	if (!proto) return warn("Pi no longer exports InteractiveMode");

	patch(proto, "addCompactionCostNotice", (original) => function (notice) {
		const cacheRead = notice?.usage?.cacheRead ?? 0;
		const children = this.chatContainer?.children;
		if (!cacheRead) return original.call(this, notice);
		if (!Array.isArray(children)) {
			warn("the compaction notice has no chatContainer");
			return original.call(this, notice);
		}

		const before = children.length;
		original.call(this, { ...notice, usage: { ...notice.usage, cacheRead: 0 } });
		try {
			// The original adds a Spacer and a ThemedText; extend the ThemedText's build.
			const text = children.length > before ? children[children.length - 1] : undefined;
			if (typeof text?.build !== "function") throw new Error("the compaction notice changed shape");
			const build = text.build;
			const reads = `${formatTokens(cacheRead)} cache reads`;
			text.build = () => {
				const line = build();
				if (line.includes(" tokens billed")) return line.replace(" tokens billed", ` tokens billed + ${reads}`);
				warn("the compaction notice text changed", "The cache reads are added after Pi's new text; check that its count is still right");
				return `${line} + ${reads}`;
			};
			text.invalidate?.();
		} catch (error) {
			// Replace the line with Pi's own, cache reads included.
			warn(errorText(error));
			children.splice(before);
			original.call(this, notice);
		}
	});

	const label = (data: CompactionModel) => {
		const { indicator, label: base } = state;
		if (!indicator || !base) return;
		if (!data.model) return warn("the compaction model is unknown");
		if (typeof indicator.setMessage !== "function") return warn("the compaction spinner has no setMessage");
		const thinking = data.model.reasoning === false ? "off" : (data.thinkingLevel ?? "off");
		// "Auto-compacting... (esc to cancel)" -> "Auto-compacting with p/model (high)... (esc to cancel)"
		indicator.setMessage(base.replace("...", ` with ${data.model.provider}/${data.model.id} (${thinking})...`));
	};

	patch(proto, "showStatusIndicator", (original) => function (indicator) {
		try {
			const compacting = indicator?.kind === "compaction" || indicator?.constructor?.name === "CompactionStatusIndicator";
			const base = compacting && typeof indicator.message === "string" ? indicator.message : undefined;
			if (compacting && !base) warn("the compaction spinner changed shape");
			state.indicator = base ? indicator : undefined;
			state.label = base;
			if (base) label({ model: this.session?.model, thinkingLevel: this.session?.thinkingLevel });
		} catch (error) {
			warn(`the spinner label failed (${errorText(error)})`);
		}
		return original.call(this, indicator);
	});

	pi.events.on("compaction:model", (data: CompactionModel) => {
		try {
			label(data);
		} catch (error) {
			warn(`the spinner label failed (${errorText(error)})`);
		}
	});
}
