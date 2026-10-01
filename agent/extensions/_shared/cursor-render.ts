const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const MAX_WRITE_CHARS = 1024 * 1024;

type CursorRenderTui = {
	readonly mode: string;
	getShowHardwareCursor(): boolean;
	terminal: { write(data: string): void; showCursor(): void; hideCursor(): void };
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
		const showCursor = terminal.showCursor;
		const hideCursor = terminal.hideCursor;
		const hadOwnWrite = Object.hasOwn(terminal, "write");
		const hadOwnShow = Object.hasOwn(terminal, "showCursor");
		const hadOwnHide = Object.hasOwn(terminal, "hideCursor");
		let suffix = "";
		let pendingEnd = false;
		let buffer = "";

		const flush = (): void => {
			if (!buffer) return;
			write.call(terminal, buffer);
			buffer = "";
		};
		const append = (data: string): void => {
			let offset = 0;
			while (offset < data.length) {
				let end = Math.min(data.length, offset + MAX_WRITE_CHARS - buffer.length);
				if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 &&
					data.charCodeAt(end - 1) <= 0xdbff && data.charCodeAt(end) >= 0xdc00 &&
					data.charCodeAt(end) <= 0xdfff) end--;
				if (end === offset) {
					flush();
					continue;
				}
				buffer += data.slice(offset, end);
				offset = end;
				if (buffer.length === MAX_WRITE_CHARS) flush();
			}
		};

		// Pi's visibility methods bypass terminal.write(). Capture them too.
		terminal.showCursor = () => append("\x1b[?25h");
		terminal.hideCursor = () => append("\x1b[?25l");

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
			// ConPTY can emit the drawing cursor before its final cursor update.
			// Hide it during painting. Pi still owns the final visibility decision.
			const hideDrawingCursor = !pendingEnd && complete.includes(BEGIN_SYNCHRONIZED_OUTPUT);
			if (complete.includes(BEGIN_SYNCHRONIZED_OUTPUT) || output.length !== complete.length) pendingEnd = true;
			if (output) append((hideDrawingCursor ? "\x1b[?25l" : "") + output);
		};

		try {
			render.call(this);
		} finally {
			if (hadOwnWrite) terminal.write = write;
			else delete (terminal as { write?: typeof write }).write;
			if (hadOwnShow) terminal.showCursor = showCursor;
			else delete (terminal as { showCursor?: typeof showCursor }).showCursor;
			if (hadOwnHide) terminal.hideCursor = hideCursor;
			else delete (terminal as { hideCursor?: typeof hideCursor }).hideCursor;
			// Cursor movement and visibility now precede the screen update's end.
			try {
				if (suffix) append(suffix);
			} finally {
				if (pendingEnd) append(END_SYNCHRONIZED_OUTPUT);
				flush();
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
