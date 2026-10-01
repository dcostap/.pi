const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";

type CursorRenderTui = {
	readonly mode: string;
	getShowHardwareCursor(): boolean;
	terminal: { write(data: string): void };
};

/** Keep regular-mode cursor placement inside Pi's screen update. */
export function keepCursorInRender(tui: CursorRenderTui): () => void {
	if (tui.mode !== "regular") return () => {};

	// Pi does not expose a public render hook. This uses its runtime method.
	const renderer = tui as unknown as { doRender(): void };
	const render = renderer.doRender;
	if (typeof render !== "function") throw new Error("Pi's regular-mode render method is not available.");
	const hadOwnRender = Object.hasOwn(renderer, "doRender");

	function renderWithCursor(this: typeof renderer): void {
		if (!tui.getShowHardwareCursor()) return render.call(this);

		const terminal = tui.terminal;
		const write = terminal.write;
		const hadOwnWrite = Object.hasOwn(terminal, "write");
		let suffix = "";
		let pendingEnd = false;

		terminal.write = (data: string): void => {
			data = suffix + data;
			let end = data.length;
			// Pi can split an escape sequence between large output chunks.
			for (let length = 1; length < END_SYNCHRONIZED_OUTPUT.length && length <= data.length; length++) {
				if (data.endsWith(END_SYNCHRONIZED_OUTPUT.slice(0, length))) end = data.length - length;
			}
			suffix = data.slice(end);
			const complete = data.slice(0, end);
			const output = complete.replaceAll(END_SYNCHRONIZED_OUTPUT, "");
			if (complete.includes(BEGIN_SYNCHRONIZED_OUTPUT) || output.length !== complete.length) pendingEnd = true;
			if (output) write.call(terminal, output);
		};

		try {
			render.call(this);
		} finally {
			if (hadOwnWrite) terminal.write = write;
			else delete (terminal as { write?: typeof write }).write;
			// Cursor movement and visibility now precede the screen update's end.
			try {
				if (suffix) write.call(terminal, suffix);
			} finally {
				if (pendingEnd) write.call(terminal, END_SYNCHRONIZED_OUTPUT);
			}
		}
	}

	renderer.doRender = renderWithCursor;
	return () => {
		if (renderer.doRender !== renderWithCursor) return;
		if (hadOwnRender) renderer.doRender = render;
		else delete (renderer as { doRender?: typeof render }).doRender;
	};
}
