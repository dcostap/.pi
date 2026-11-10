import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
	clampThinkingLevel: (_model: unknown, level: string) => level,
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	ModelSelectorComponent: class {
		constructor(
			_tui: unknown,
			_model: unknown,
			_runtime: unknown,
			_scoped: unknown,
			readonly select: (model: unknown) => void,
			readonly cancel: () => void,
		) {}
	},
}));
const { default: register } = await import("../insert-model.ts");

function setup(text: string, cursor: number, cancel = false) {
	let handler: (ctx: any) => Promise<void>;
	const chosen = { provider: "test", id: "chosen" };
	const state = { text, cursor, pastes: 0, restores: 0 };
	const editor = {
		getText: () => state.text,
		setText: (value: string) => {
			state.text = value;
			state.cursor = value.length;
			state.restores++;
		},
	};
	const originalSetText = editor.setText;
	register({
		getSettings: () => ({ defaultThinkingLevel: "high" }),
		registerShortcut: (key: string, shortcut: any) => {
			expect(key).toBe("ctrl+g");
			handler = shortcut.handler;
		},
	} as any);
	const ctx = {
		mode: "tui",
		model: chosen,
		modelRegistry: { runtime: {} },
		scopedModels: [],
		ui: {
			custom: async (factory: any, options: any) => {
				expect(options?.overlay).not.toBe(true);
				const savedText = state.text;
				let result: string | undefined;
				const picker = factory({ getFocusedComponent: () => editor }, {}, {}, (value: string | undefined) => {
					// Pi restores inline dialogs synchronously when done() runs.
					editor.setText(savedText);
					result = value;
				});
				if (cancel) picker.cancel();
				else picker.select(chosen);
				expect(editor.setText).toBe(originalSetText);
				return result;
			},
			pasteToEditor: (value: string) => {
				state.text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
				state.cursor += value.length;
				state.pastes++;
			},
		},
	};
	return { state, run: () => handler(ctx) };
}

for (const [text, cursor] of [["before after", 7], ["after", 0], ["first\nbefore after\nlast", 13]] as const) {
	test(`inserts at cursor ${cursor} in ${JSON.stringify(text)}`, async () => {
		const { state, run } = setup(text, cursor);
		await run();
		const inserted = "test/chosen:high ";
		expect(state.text).toBe(text.slice(0, cursor) + inserted + text.slice(cursor));
		expect(state.cursor).toBe(cursor + inserted.length);
		expect(state.pastes).toBe(1);
		expect(state.restores).toBe(0);
	});
}

test("cancel keeps the prompt and cursor unchanged", async () => {
	const { state, run } = setup("before after", 7, true);
	await run();
	expect(state).toEqual({ text: "before after", cursor: 7, pastes: 0, restores: 0 });
});
