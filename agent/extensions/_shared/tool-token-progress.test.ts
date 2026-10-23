import { afterEach, describe, expect, mock, test } from "bun:test";
import { Box, hyperlink, Text } from "@earendil-works/pi-tui";

const nativeHeader = `native ${hyperlink("file.ts", "file:///C:/project/file.ts")}`;
function definition(name: string) {
	return {
		name,
		renderCall(_args: unknown, _theme: unknown, context: any) {
			const component = context.lastComponent ?? (name === "edit" ? new Box(0, 0) : new Text(nativeHeader, 0, 0));
			if (component instanceof Box && component.children.length === 0) component.addChild(new Text(`${nativeHeader}\nnative details`, 0, 0));
			context.state.callComponent = component;
			return component;
		},
		renderResult() { return new Text("native result", 0, 0); },
	};
}
mock.module("@earendil-works/pi-coding-agent", () => ({
	createEditToolDefinition: () => definition("edit"),
	createWriteToolDefinition: () => definition("write"),
}));
const { default: extension } = await import("../tool-token-progress.ts");
afterEach(() => mock.restore());
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

describe("token progress headers", () => {
	for (const name of ["edit", "write"]) {
		test(`preserves the native ${name} link without duplicate token counts`, () => {
			const tools = new Map<string, any>();
			const handlers = new Map<string, Function>();
			extension({ events: { on() {}, emit() {} }, on: (event: string, handler: Function) => handlers.set(event, handler), registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
			handlers.get("session_start")!({}, { cwd: "C:/project" });
			const tool = tools.get(name);
			const args = { path: "file.ts", content: "hello" };
			const context: any = { cwd: "C:/project", toolCallId: "call", args, state: {} };
			const first = tool.renderCall(args, theme, context);
			context.lastComponent = first;
			const second = tool.renderCall(args, theme, context);
			tool.renderResult?.({ content: [] }, {}, theme, context);
			const rendered = second.render(200).join("\n");
			expect(rendered).toContain(nativeHeader);
			expect(rendered.match(/↓\d+/g)).toHaveLength(1);
			if (name === "edit") expect(rendered).toContain("native details");
		});
	}
});
