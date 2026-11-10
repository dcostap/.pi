import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

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
				const selected = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
					const editor = tui.getFocusedComponent() as Partial<EditorComponent> | null;
					const finish = (value: string | undefined) => {
						// Inline dialogs restore text with setText(). Skip unchanged text to preserve the cursor and paste state.
						const setText = editor?.setText;
						const getText = editor?.getText;
						if (editor && setText && getText) {
							editor.setText = (text) => {
								if (text !== getText.call(editor)) setText.call(editor, text);
							};
						}
						try {
							done(value);
						} finally {
							if (editor && setText) editor.setText = setText;
						}
					};
					return new ModelSelectorComponent(
						tui,
						ctx.model,
						ctx.modelRegistry.runtime,
						ctx.scopedModels,
						(model) => finish(`${model.provider}/${model.id}:${thinkingLevel(model)}`),
						() => finish(undefined),
					);
				});
				if (selected !== undefined) ctx.ui.pasteToEditor(`${selected} `);
			} finally {
				picking = false;
			}
		},
	});
}
