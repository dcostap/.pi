import { describe, expect, test } from "bun:test";
import { renderBackgroundStartCall } from "./tool-call.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("background start tool-call rendering", () => {
	test("shows the actual command and background title in chat history", () => {
		const component = renderBackgroundStartCall(
			{ command: "bun test ./src", title: "Unit tests" },
			theme,
		);

		expect(component.render(200).join("\n")).toBe("$ bun test ./src (background · Unit tests)");
	});

	test("updates the existing component and strips terminal control sequences", () => {
		const component = renderBackgroundStartCall({ command: "old", title: "Old" }, theme);
		const updated = renderBackgroundStartCall(
			{ command: "safe\x1b]0;hidden\x07 command", title: "New\x1b[31m title" },
			theme,
			component,
		);

		expect(updated).toBe(component);
		expect(updated.render(200).join("\n")).toBe("$ safe command (background · New title)");
	});
});
