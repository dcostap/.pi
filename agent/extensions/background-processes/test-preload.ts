import { mock } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
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
}));
