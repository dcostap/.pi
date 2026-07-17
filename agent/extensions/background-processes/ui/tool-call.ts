import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { normalizeTitle } from "../prompt.ts";
import { sanitizeTerminalText } from "../sanitize.ts";

export interface BackgroundStartCallArgs {
	command?: unknown;
	title?: unknown;
}

export function renderBackgroundStartCall(
	args: BackgroundStartCallArgs,
	theme: Theme,
	previous?: Text,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const command = typeof args?.command === "string" ? sanitizeTerminalText(args.command) : "";
	const title = typeof args?.title === "string" ? sanitizeTerminalText(normalizeTitle(args.title)) : "";
	const commandDisplay = command ? theme.fg("accent", command) : theme.fg("toolOutput", "…");
	const backgroundLabel = title ? ` (background · ${title})` : " (background)";
	component.setText(
		theme.fg("toolTitle", theme.bold("$ ")) + commandDisplay + theme.fg("muted", backgroundLabel),
	);
	return component;
}
