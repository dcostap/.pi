import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	let picking = false;

	pi.registerShortcut("ctrl+g", {
		description: "Insert a model ID and its default thinking level at the cursor",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || picking) return;

			// Same order as Pi's startup: scoped pin, per-model setting, global default.
			const settings = pi.getSettings();
			const thinkingLevel = (model: (typeof ctx.scopedModels)[number]["model"]) => {
				const id = `${model.provider}/${model.id}`;
				const level = ctx.scopedModels.find((scoped) => `${scoped.model.provider}/${scoped.model.id}` === id)?.thinkingLevel
					?? settings.modelThinkingLevels?.[id]
					?? settings.defaultThinkingLevel
					?? "medium";
				return clampThinkingLevel(model, level);
			};

			picking = true;
			try {
				// Pi's own /model selector, so the picker looks and works the same as Ctrl+P.
				const selected = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) =>
					new ModelSelectorComponent(
						tui,
						ctx.model,
						ctx.modelRegistry.runtime,
						ctx.scopedModels,
						(model) => done(`${model.provider}/${model.id}:${thinkingLevel(model)}`),
						() => done(undefined),
					),
				);
				if (selected !== undefined) ctx.ui.pasteToEditor(selected);
			} finally {
				picking = false;
			}
		},
	});
}
