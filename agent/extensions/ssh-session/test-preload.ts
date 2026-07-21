import { mock } from "bun:test";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;

mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize(bytes: number) {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	},
	highlightCode(code: string, language?: string) {
		return code.split("\n").map((line) => `<${language}>${line}</${language}>`);
	},
	keyHint(_keybinding: string, description: string) {
		return `ctrl+o ${description}`;
	},
	truncateTail(content: string, options: { maxBytes?: number; maxLines?: number } = {}) {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
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
	Text: class Text {
		constructor(private text: string) {}
		setText(text: string) { this.text = text; }
		render() { return this.text.split("\n"); }
		invalidate() {}
	},
}));
