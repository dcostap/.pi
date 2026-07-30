import { mock } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	VERSION: "test",
}));

mock.module("@earendil-works/pi-tui", () => ({
	truncateToWidth(text: string, width: number, ellipsis = "...") {
		if (text.length <= width) return text;
		if (width <= ellipsis.length) return ellipsis.slice(0, width);
		return text.slice(0, width - ellipsis.length) + ellipsis;
	},
	visibleWidth(text: string) {
		return text.replace(/\x1b\[[0-9;]*m/gu, "").length;
	},
}));
