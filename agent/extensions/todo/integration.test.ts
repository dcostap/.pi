import { describe, expect, test, mock } from "bun:test";

const bashOperations = {
	async exec(_command: string, _cwd: string, options: { onData?: (chunk: Buffer) => void }) {
		options.onData?.(Buffer.from("watch passed\n"));
		return { exitCode: 0 };
	},
};

const schema = (..._args: unknown[]) => ({});
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: schema }));
mock.module("typebox", () => ({
	Type: {
		Object: schema,
		Array: schema,
		Optional: schema,
		String: schema,
		Boolean: schema,
		Integer: schema,
		Number: schema,
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: class Box {
		constructor(..._args: unknown[]) {}
		addChild(_child: unknown) {}
	},
	Text: class Text {
		constructor(private value = "", ..._args: unknown[]) {}
		setText(value: string) { this.value = value; }
		render() { return this.value.split("\n"); }
		invalidate() {}
	},
	matchesKey(data: string, key: string) {
		return key === "escape" ? data === "\x1b" : key === "return" ? data === "\r" || data === "\n" : false;
	},
	truncateToWidth(value: string, width: number) { return value.slice(0, width); },
	visibleWidth(value: string) { return value.length; },
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 50 * 1024,
	DEFAULT_MAX_LINES: 2000,
	createLocalBashOperations: () => bashOperations,
}));

const { default: todoExtension } = await import("./index.ts");
const { todoWidgetLines } = await import("./widget.ts");

type Handler = (...args: any[]) => any;

function makeHarness() {
	const entries: any[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const tools = new Map<string, any>();
	const widgetValues: unknown[] = [];
	const notices: string[] = [];
	const emitted: Array<{ name: string; value: unknown }> = [];
	let customCalls = 0;
	let activeTools = ["read", "bash"];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: { handler: Handler }) { commands.set(name, definition); },
		registerMessageRenderer() {},
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
		events: { emit(name: string, value: unknown) { emitted.push({ name, value }); } },
	};
	const ctx: any = {
		mode: "rpc",
		hasUI: true,
		cwd: "C:/project",
		isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		ui: {
			setWidget(_key: string, value: unknown) { widgetValues.push(value); },
			notify(message: string) { notices.push(message); },
			async confirm() { return true; },
			async input() { return undefined; },
			async editor() { return undefined; },
			async select() { return undefined; },
			async custom() { customCalls++; return undefined; },
		},
	};
	todoExtension(pi as any);
	return { entries, handlers, commands, tools, widgetValues, notices, emitted, getActiveTools: () => activeTools, getCustomCalls: () => customCalls, ctx };
}

async function invoke(harness: ReturnType<typeof makeHarness>, event: string, ...args: any[]): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) await handler(...args);
}

describe("todo extension integration", () => {
	test("summarizes hidden completed tasks inside each visible widget group", () => {
		const item = (id: string, group: string, done: boolean, completedAt?: number) => ({
			id,
			kind: "task" as const,
			text: id,
			group,
			done,
			createdAt: 1,
			updatedAt: completedAt ?? 1,
			completedAt,
		});
		const state = {
			version: 1 as const,
			enabled: true,
			scriptsEnabled: true,
			nextSequence: 15,
			items: [
				item("g1-open", "Group 1", false),
				...Array.from({ length: 6 }, (_, index) => item(`g1-done-${index + 1}`, "Group 1", true, index * 2 + 1)),
				item("g2-open", "Group 2", false),
				...Array.from({ length: 6 }, (_, index) => item(`g2-done-${index + 1}`, "Group 2", true, index * 2 + 2)),
			],
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => text,
		};
		const lines = todoWidgetLines(state, theme as any, () => undefined, 1);
		expect(lines).toContain("  … 3 others completed");
		expect(lines).toContain("  … 2 others completed");
		expect(lines.filter((line) => line.includes("✓")).length).toBe(7);
	});

	test("loads only the command, then activates the tool and persists state", async () => {
		const harness = makeHarness();
		await invoke(harness, "session_start", {}, harness.ctx);
		expect(harness.tools.has("todo")).toBe(false);
		expect(harness.getActiveTools()).not.toContain("todo");

		await harness.commands.get("todo")!.handler("on", harness.ctx);
		expect(harness.tools.has("todo")).toBe(true);
		expect(harness.getActiveTools()).toContain("todo");
		expect(harness.entries.at(-1)?.data.enabled).toBe(true);
		expect(harness.widgetValues.length).toBeGreaterThan(0);
		expect(harness.getCustomCalls()).toBe(0);
	});

	test("applies grouped tasks and runs a command watch", async () => {
		const harness = makeHarness();
		await invoke(harness, "session_start", {}, harness.ctx);
		await harness.commands.get("todo")!.handler("on", harness.ctx);
		const tool = harness.tools.get("todo");
		const applied = await tool.execute("call-1", {
			op: "apply",
			changes: [
				{ action: "add", kind: "task", text: "Review code", group: "Smoke" },
				{ action: "add", kind: "watch", text: "Tests stay green", every: "10m", schedule_action: "command", command: "npm test" },
				{ action: "set_current", id: "t-1" },
			],
		}, undefined, undefined, harness.ctx);
		expect(applied.details.state.items.map((item: any) => item.id)).toEqual(["t-1", "w-2"]);
		expect(applied.details.state.items[0].group).toBe("Smoke");
		expect(applied.content[0].text).toContain("Review code · CURRENT");
		expect(harness.emitted.at(-1)).toEqual({
			name: "todo:status",
			value: { status: { current: { id: "t-1", text: "Review code" }, completed: 0, total: 1 } },
		});
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = tool.renderResult(applied, { expanded: false }, theme, { isError: false }).render().join("\n");
		expect(rendered).toContain("+ [ ] t-1 [Smoke] Review code");
		expect(rendered).toContain("+ CURRENT t-1 · Review code");
		expect(rendered).not.toContain("\nSmoke:");

		const run = await tool.execute("call-2", { op: "run", id: "w-2" }, undefined, undefined, harness.ctx);
		expect(run.details.run.status).toBe("success");
		expect(run.details.run.output).toBe("watch passed");
	});

	test("removes the tool and widget while preserving disabled state", async () => {
		const harness = makeHarness();
		await invoke(harness, "session_start", {}, harness.ctx);
		await harness.commands.get("todo")!.handler("on", harness.ctx);
		await harness.commands.get("todo")!.handler("off", harness.ctx);
		expect(harness.getActiveTools()).not.toContain("todo");
		expect(harness.entries.at(-1)?.data.enabled).toBe(false);
		expect(harness.widgetValues.at(-1)).toBeUndefined();
		expect(harness.notices.at(-1)).toContain("disabled");
	});
});
