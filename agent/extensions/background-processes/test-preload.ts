import { mock } from "bun:test";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;

mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	/** Minimal stand-in with Pi's contract: run operations.exec and rethrow unknown errors unchanged. */
	createBashToolDefinition(cwd: string, options: { operations?: any } = {}) {
		return {
			name: "bash",
			label: "bash",
			description: "Execute a bash command. Optionally provide a timeout in seconds.",
			parameters: {},
			cwd,
			async execute(_id: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				let text = "";
				let result;
				try {
					result = await options.operations.exec(params.command, ctx?.cwd ?? cwd, {
						signal,
						timeout: params.timeout,
						env: { PI_TEST: "1" },
						onData: (data: Buffer) => {
							text += data.toString();
							onUpdate?.({ content: [{ type: "text", text }], details: undefined });
						},
					});
				} catch (error) {
					if (error instanceof Error && error.message === "aborted") throw new Error(`${text}\n\nCommand aborted`);
					throw error;
				}
				return { content: [{ type: "text", text: text || "(no output)" }], details: undefined, exitCode: result.exitCode };
			},
			renderCall() {
				return { render: () => ["builtin call"], invalidate() {} };
			},
			renderResult(result: any) {
				const children: any[] = [];
				return {
					children,
					addChild(child: any) { children.push(child); },
					clear() { children.length = 0; },
					render: (width?: number) => [`builtin:${result.content[0]?.text ?? ""}`, ...children.flatMap((child) => child.render(width))],
					invalidate() {},
				};
			},
		};
	},
	truncateToVisualLines(text: string, maxVisualLines: number) {
		const lines = text.split("\n");
		const visualLines = lines.slice(-maxVisualLines);
		return { visualLines, skippedCount: lines.length - visualLines.length };
	},
	highlightCode(code: string, language?: string) {
		return code.split("\n").map((line) => `<${language}>${line}</${language}>`);
	},
	keyHint(_keybinding: string, description: string) {
		return `ctrl+e ${description}`;
	},
	formatSize(bytes: number) {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	},
	truncateTail(content: string, options: { maxBytes?: number; maxLines?: number } = {}) {
		const maxBytes = options.maxBytes ?? 50 * 1024;
		const maxLines = options.maxLines ?? 2000;
		const sourceLines = content.split("\n");
		let lines = sourceLines.slice(-maxLines);
		let candidate = lines.join("\n");
		while (Buffer.byteLength(candidate, "utf8") > maxBytes && lines.length > 1) {
			lines.shift();
			candidate = lines.join("\n");
		}
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
			candidate = Buffer.from(candidate, "utf8").subarray(-maxBytes).toString("utf8");
		}
		return {
			content: candidate,
			truncated: candidate !== content,
			truncatedBy: candidate === content ? null : "bytes",
			totalLines: sourceLines.length,
			totalBytes: Buffer.byteLength(content, "utf8"),
			outputLines: candidate.split("\n").length,
			outputBytes: Buffer.byteLength(candidate, "utf8"),
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	},
}));

mock.module("@earendil-works/pi-tui", () => ({
	Box: class Box {
		private readonly children: Array<{ render(width?: number): string[] }> = [];
		constructor(
			private readonly paddingX = 0,
			private readonly paddingY = 0,
			private readonly bg?: (text: string) => string,
		) {}
		addChild(child: { render(width?: number): string[] }) { this.children.push(child); }
		render(width?: number) {
			const padding = " ".repeat(this.paddingX);
			const blank = this.bg?.(" ".repeat(Math.max(0, width ?? 0))) ?? "";
			return [
				...Array.from({ length: this.paddingY }, () => blank),
				...this.children.flatMap((child) => child.render(width).map((line) => (
					this.bg?.(`${padding}${line}${padding}`) ?? `${padding}${line}${padding}`
				))),
				...Array.from({ length: this.paddingY }, () => blank),
			];
		}
		invalidate() {}
	},
	Container: class Container {
		children: Array<{ render(width?: number): string[] }> = [];
		addChild(child: { render(width?: number): string[] }) { this.children.push(child); }
		clear() { this.children.length = 0; }
		render(width?: number) { return this.children.flatMap((child) => child.render(width)); }
		invalidate() {}
	},
	Text: class Text {
		constructor(
			private text: string,
			private readonly paddingX = 0,
			private readonly paddingY = 0,
		) {}
		setText(text: string) { this.text = text; }
		render() {
			const padding = " ".repeat(this.paddingX);
			return [
				...Array.from({ length: this.paddingY }, () => ""),
				...this.text.split("\n").map((line) => `${padding}${line}${padding}`),
				...Array.from({ length: this.paddingY }, () => ""),
			];
		}
		invalidate() {}
	},
	matchesKey(data: string, key: string) {
		if (key === "return") return data === "\r" || data === "\n";
		if (key === "escape") return data === "\x1b";
		if (key === "ctrl+c") return data === "\x03";
		if (key === "up") return data === "UP";
		if (key === "down") return data === "DOWN";
		return data === key;
	},
	truncateToWidth(text: string, width: number, ellipsis = "...") {
		if (text.length <= width) return text;
		if (width <= ellipsis.length) return ellipsis.slice(0, width);
		return text.slice(0, width - ellipsis.length) + ellipsis;
	},
	visibleWidth(text: string) {
		return text.replace(/\x1b\[[0-9;]*m/gu, "").length;
	},
}));

const Type = {
	Object(properties: Record<string, unknown>, options: Record<string, unknown> = {}) { return { type: "object", properties, ...options }; },
	Optional(schema: unknown) { return schema; },
	String(options: Record<string, unknown> = {}) { return { type: "string", ...options }; },
	Number(options: Record<string, unknown> = {}) { return { type: "number", ...options }; },
	Boolean(options: Record<string, unknown> = {}) { return { type: "boolean", ...options }; },
};
mock.module("typebox", () => ({ Type }));
