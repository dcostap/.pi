import { StringEnum } from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TodoDashboard, type DashboardAction } from "./dashboard.ts";
import { formatAgentTodoContext, formatReminder, formatRunResult, formatTodoItemDetails, formatTodoState } from "./format.ts";
import { WatchRunner } from "./runner.ts";
import { TodoScheduler } from "./scheduler.ts";
import {
	TODO_STATE_ENTRY,
	applyTodoChanges,
	cloneTodoState,
	findItem,
	replaceItem,
	restoreTodoState,
	setFeatureEnabled,
	setScriptsEnabled,
} from "./state.ts";
import type { TodoChange, TodoItem, TodoRunSummary, TodoState, TodoToolInput } from "./types.ts";
import { todoWidgetComponent } from "./widget.ts";

const TODO_TOOL_NAME = "todo";
const TODO_WAKE_MESSAGE = "todo-reminder-v1";

const ChangeSchema = Type.Object({
	action: StringEnum([
		"add",
		"edit",
		"complete",
		"reopen",
		"remove",
		"move",
		"set_schedule",
		"disable_schedule",
		"rename_group",
	] as const),
	id: Type.Optional(Type.String({ description: "Stable task or watch ID" })),
	kind: Type.Optional(StringEnum(["task", "watch"] as const)),
	text: Type.Optional(Type.String({ description: "Item text" })),
	group: Type.Optional(Type.String({ description: "Optional free-form group heading" })),
	clear_group: Type.Optional(Type.Boolean({ description: "Move an item out of its group" })),
	before_id: Type.Optional(Type.String({ description: "For move, insert before this item. Omit to move to the end." })),
	new_group: Type.Optional(Type.String({ description: "New heading for rename_group" })),
	every: Type.Optional(Type.String({ description: 'Repeat interval, such as "30s", "10m", "2h", or "1d"' })),
	schedule_action: Type.Optional(StringEnum(["remind", "command"] as const)),
	command: Type.Optional(Type.String({ description: "Non-interactive bash command for a command watch" })),
	cwd: Type.Optional(Type.String({ description: "Command working directory, relative to the session directory by default" })),
	timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
});

const TodoParameters = Type.Object({
	op: StringEnum(["view", "apply", "run"] as const),
	changes: Type.Optional(Type.Array(ChangeSchema, { minItems: 1, maxItems: 100 })),
	id: Type.Optional(Type.String({ description: "Command watch ID for run" })),
});

export default function todoExtension(pi: ExtensionAPI): void {
	let state = restoreTodoState([]);
	let latestContext: ExtensionContext | undefined;
	let toolRegistered = false;
	let shuttingDown = false;
	let mutationTail: Promise<void> = Promise.resolve();
	const runner = new WatchRunner(createLocalBashOperations());
	const wakeQueue = new WakeQueue((content) => {
		if (shuttingDown || !state.enabled) return;
		pi.sendMessage(
			{
				customType: TODO_WAKE_MESSAGE,
				content,
				display: true,
				details: { createdAt: Date.now() },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
	const scheduler = new TodoScheduler({ onDue: (item) => handleScheduledItem(item) });

	function serialize<T>(work: () => Promise<T> | T): Promise<T> {
		const result = mutationTail.then(work, work);
		mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	function persist(next: TodoState, ctx?: ExtensionContext): TodoState {
		state = next;
		pi.appendEntry(TODO_STATE_ENTRY, cloneTodoState(state));
		refreshRuntime(ctx ?? latestContext);
		return state;
	}

	function refreshRuntime(ctx?: ExtensionContext): void {
		if (ctx) latestContext = ctx;
		if (!state.enabled) {
			scheduler.stop();
			wakeQueue.clear();
			if (latestContext?.hasUI) latestContext.ui.setWidget("todo", undefined);
			deactivateTool();
			return;
		}
		ensureToolRegistered();
		activateTool();
		scheduler.sync(state);
		updateWidget();
	}

	function updateWidget(): void {
		const ctx = latestContext;
		if (!ctx?.hasUI || ctx.mode !== "tui" || !state.enabled || shuttingDown) return;
		const snapshot = cloneTodoState(state);
		ctx.ui.setWidget("todo", (tui, theme) => todoWidgetComponent(snapshot, theme, scheduler, () => tui.requestRender()));
	}

	function ensureToolRegistered(): void {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: TODO_TOOL_NAME,
			label: "Todo",
			description: `Manage the enabled session todo list.

Operations:
- view: return the authoritative list.
- apply: atomically apply changes and return the authoritative list.
- run: run one configured command watch now; pass its stable ID in id.

Apply actions:
- add: kind and text; optional group. Add every plus schedule_action to create a schedule.
- edit: id; optional text, group, or clear_group.
- complete/reopen/remove: id.
- move: id; optional before_id and group. Omit before_id to move to the end.
- set_schedule: id, every, and schedule_action. Command schedules also require command and support cwd and timeout_seconds.
- disable_schedule: id.
- rename_group: group and new_group.

Tasks are checkable and can repeat text reminders. Watches stay until removed and can repeat reminders or non-interactive commands. Intervals use values such as 30s, 10m, 2h, or 1d. IDs are authoritative; do not identify items by text.`,
			promptSnippet: "View or update the enabled session todo list and its recurring watches",
			promptGuidelines: [
				"Use todo only when a persistent list helps; do not create a list for each small task.",
				"Use todo apply with multiple changes when related list edits can be atomic.",
				"Complete todo tasks only after their work is complete.",
				"Use todo watches for standing rules, repeating reminders, and recurring command checks.",
				"After setting or changing a todo command watch, use todo run once to verify the command.",
				"Todo watch commands must be non-interactive, bounded, and safe to repeat.",
			],
			parameters: TodoParameters,
			async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
				latestContext = ctx;
				if (!state.enabled) throw new Error("The todo feature is disabled. The user must run /todo on.");
				const params = rawParams as TodoToolInput;
				if (params.op === "view") return todoResult("view", state);
				if (params.op === "apply") {
					const next = await serialize(() => applyTodoChanges(state, params.changes ?? []));
					persist(next, ctx);
					return todoResult("apply", state);
				}
				if (params.op === "run") {
					const id = params.id?.trim();
					if (!id) throw new Error("id is required for run");
					const { item, run } = await runWatch(id, ctx.cwd, signal);
					return {
						content: [{ type: "text", text: formatRunResult(item, run) }],
						details: { op: "run", item, run, state: cloneTodoState(state) },
					};
				}
				throw new Error(`Unknown todo operation: ${(params as { op?: string }).op}`);
			},
			renderCall(args, theme, context) {
				const current = (context.args as TodoToolInput | undefined) ?? (args as TodoToolInput);
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const count = current.changes?.length ?? 0;
				text.setText(theme.fg("toolTitle", theme.bold("Todo")) + theme.fg("muted", `  ${current.op}${count ? ` · ${count} changes` : ""}${current.id ? ` · ${current.id}` : ""}`));
				return text;
			},
			renderResult(result, options, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const body = result.content.find((part) => part.type === "text")?.text ?? "";
				const lines = body.split("\n");
				text.setText(theme.fg(context.isError ? "error" : "muted", options.expanded ? body : lines.slice(0, 10).join("\n")));
				return text;
			},
		});
	}

	function activateTool(): void {
		const active = pi.getActiveTools();
		if (!active.includes(TODO_TOOL_NAME)) pi.setActiveTools([...active, TODO_TOOL_NAME]);
	}

	function deactivateTool(): void {
		if (!toolRegistered) return;
		const active = pi.getActiveTools();
		if (active.includes(TODO_TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TODO_TOOL_NAME));
	}

	async function runWatch(id: string, cwd: string, signal?: AbortSignal): Promise<{ item: TodoItem; run: TodoRunSummary }> {
		const item = cloneTodoState({ ...state, items: [structuredClone(findItem(state, id))] }).items[0]!;
		const run = await runner.run(item, cwd, signal);
		await serialize(() => {
			const current = state.items.find((candidate) => candidate.id === id);
			if (!current) return;
			const updated = structuredClone(current);
			updated.lastRun = run;
			updated.updatedAt = Date.now();
			persist(replaceItem(state, updated));
		});
		return { item: { ...item, lastRun: run }, run };
	}

	async function handleScheduledItem(snapshot: TodoItem): Promise<void> {
		if (shuttingDown || !state.enabled) return;
		const current = state.items.find((item) => item.id === snapshot.id);
		if (!current?.schedule?.enabled) return;
		if (current.schedule.action === "remind") {
			await serialize(() => {
				const fresh = state.items.find((item) => item.id === snapshot.id);
				if (!fresh?.schedule?.enabled) return;
				const updated = structuredClone(fresh);
				updated.schedule!.lastTriggeredAt = Date.now();
				updated.updatedAt = Date.now();
				persist(replaceItem(state, updated));
				wakeQueue.add(formatReminder(updated));
			});
			return;
		}
		if (!state.scriptsEnabled || runner.isRunning(current.id)) return;
		const ctx = latestContext;
		if (!ctx) return;
		try {
			const { item, run } = await runWatch(current.id, ctx.cwd);
			if (!shuttingDown && state.enabled && state.scriptsEnabled && run.status === "failed") wakeQueue.add(formatRunResult(item, run));
		} catch (error) {
			if (!shuttingDown && state.enabled) {
				wakeQueue.add(`Watch ${current.id} · ${current.text}\nCould not run command: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	pi.registerMessageRenderer(TODO_WAKE_MESSAGE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		const lines = expanded ? content : content.split("\n").slice(0, 18).join("\n");
		const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
		box.addChild(new Text(theme.fg("warning", theme.bold("Todo wake")) + `\n${theme.fg("muted", lines)}`, 0, 0));
		return box;
	});

	pi.registerCommand("todo", {
		description: "Enable, disable, or inspect the session todo list",
		getArgumentCompletions: (prefix) => ["on", "off", "scripts on", "scripts off"]
			.filter((value) => value.startsWith(prefix.toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			latestContext = ctx;
			const command = args.trim().toLowerCase().replace(/\s+/gu, " ");
			if (command === "on") {
				persist(setFeatureEnabled(state, true), ctx);
				scheduler.start(state);
				refreshRuntime(ctx);
				ctx.ui.notify("Todo list enabled for this session.", "info");
				return;
			}
			if (command === "off") {
				runner.cancelAll();
				persist(setFeatureEnabled(state, false), ctx);
				ctx.ui.notify("Todo list disabled. Its state was preserved.", "info");
				return;
			}
			if (command === "scripts on" || command === "scripts off") {
				const enabled = command.endsWith("on");
				if (!enabled) runner.cancelAll();
				persist(setScriptsEnabled(state, enabled), ctx);
				ctx.ui.notify(`Automatic todo commands ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (command) {
				ctx.ui.notify("Usage: /todo, /todo on, /todo off, or /todo scripts on|off", "warning");
				return;
			}
			if (!state.enabled) {
				if (!ctx.hasUI || !(await ctx.ui.confirm("Enable todos?", "Enable the session todo list, reminders, and automatic watch commands?"))) return;
				persist(setFeatureEnabled(state, true), ctx);
				scheduler.start(state);
				refreshRuntime(ctx);
				// First activation should only enable the feature. Do not open the
				// dashboard as a side effect of the activation command.
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatTodoState(state), "info");
				return;
			}
			await openDashboard(ctx);
		},
	});

	async function openDashboard(ctx: ExtensionContext): Promise<void> {
		while (state.enabled && !shuttingDown) {
			const snapshot = cloneTodoState(state);
			const action = await ctx.ui.custom<DashboardAction>(
				(tui, theme, keybindings, done) => {
					const dashboard = new TodoDashboard(snapshot, theme, keybindings, done);
					return {
						render: (width) => dashboard.render(width),
						invalidate: () => dashboard.invalidate(),
						handleInput: (data) => { dashboard.handleInput(data); tui.requestRender(); },
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", minWidth: 64, maxHeight: "85%", margin: 1 },
				},
			);
			if (!action || action.type === "close") return;
			await handleDashboardAction(action, ctx);
		}
	}

	async function handleDashboardAction(action: Exclude<DashboardAction, { type: "close" }>, ctx: ExtensionContext): Promise<void> {
		if (action.type === "add_task" || action.type === "add_watch") {
			const text = await ctx.ui.input(action.type === "add_task" ? "New task" : "New watch", "Describe the item");
			if (!text?.trim()) return;
			const group = await ctx.ui.input("Optional group", "Leave empty for no group");
			await applyUiChanges([{ action: "add", kind: action.type === "add_task" ? "task" : "watch", text, group: group?.trim() || undefined }], ctx);
			return;
		}
		if (!("id" in action)) return;
		const item = state.items.find((candidate) => candidate.id === action.id);
		if (!item) return;
		if (action.type === "inspect") {
			await showItemDetails(item, ctx);
			return;
		}
		if (action.type === "toggle") {
			await applyUiChanges([{ action: item.done ? "reopen" : "complete", id: item.id }], ctx);
			return;
		}
		if (action.type === "edit") {
			const text = await ctx.ui.editor(`Edit ${item.id}`, item.text);
			if (text?.trim() && text.trim() !== item.text) await applyUiChanges([{ action: "edit", id: item.id, text }], ctx);
			return;
		}
		if (action.type === "delete") {
			if (await ctx.ui.confirm(`Delete ${item.id}?`, item.text)) await applyUiChanges([{ action: "remove", id: item.id }], ctx);
			return;
		}
		if (action.type === "group") {
			const group = await ctx.ui.input(`Group for ${item.id}`, item.group ?? "");
			if (group === undefined) return;
			await applyUiChanges([{ action: "edit", id: item.id, group: group.trim() || undefined, clear_group: !group.trim() }], ctx);
			return;
		}
		if (action.type === "schedule") {
			await configureSchedule(item, ctx);
			return;
		}
		if (action.type === "run") {
			if (item.kind !== "watch" || item.schedule?.action !== "command") {
				ctx.ui.notify(`${item.id} is not a command watch.`, "warning");
				return;
			}
			ctx.ui.notify(`Running ${item.id}…`, "info");
			const { run } = await runWatch(item.id, ctx.cwd);
			ctx.ui.notify(formatRunResult(item, run), run.status === "success" ? "info" : "warning");
			return;
		}
		if (action.type === "move_up" || action.type === "move_down") {
			const index = state.items.findIndex((candidate) => candidate.id === item.id);
			if (action.type === "move_up" && index > 0) {
				await applyUiChanges([{ action: "move", id: item.id, before_id: state.items[index - 1]!.id }], ctx);
			} else if (action.type === "move_down" && index >= 0 && index < state.items.length - 1) {
				await applyUiChanges([{ action: "move", id: state.items[index + 1]!.id, before_id: item.id }], ctx);
			}
		}
	}

	async function showItemDetails(item: TodoItem, ctx: ExtensionContext): Promise<void> {
		const content = `${formatTodoItemDetails(item)}\n\nPress Escape or Enter to close.`;
		await ctx.ui.custom<void>(
			(_tui, theme, keybindings, done) => {
				const text = new Text(theme.fg("muted", content), 1, 1);
				return {
					render: (width) => text.render(width),
					invalidate: () => text.invalidate(),
					handleInput: (data) => {
						if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm") || data === "q" || data === "Q") done(undefined);
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "75%", minWidth: 56, maxHeight: "80%", margin: 2 } },
		);
	}

	async function configureSchedule(item: TodoItem, ctx: ExtensionContext): Promise<void> {
		const options = ["Text reminder", ...(item.kind === "watch" ? ["Command watch"] : []), ...(item.schedule ? ["Disable schedule"] : []), "Cancel"];
		const choice = await ctx.ui.select(`Schedule ${item.id}`, options);
		if (!choice || choice === "Cancel") return;
		if (choice === "Disable schedule") {
			await applyUiChanges([{ action: "disable_schedule", id: item.id }], ctx);
			return;
		}
		const everyInput = await ctx.ui.input("Repeat interval", item.schedule?.every ?? "10m");
		if (everyInput === undefined) return;
		const every = everyInput.trim() || item.schedule?.every || "10m";
		if (choice === "Text reminder") {
			await applyUiChanges([{ action: "set_schedule", id: item.id, every, schedule_action: "remind" }], ctx);
			return;
		}
		const command = await ctx.ui.editor("Non-interactive bash command", item.schedule?.command ?? "");
		if (!command?.trim()) return;
		const cwd = await ctx.ui.input("Optional working directory", item.schedule?.cwd ?? "");
		const timeoutText = await ctx.ui.input("Timeout in seconds", String(item.schedule?.timeoutSeconds ?? 300));
		if (timeoutText === undefined) return;
		const timeout = Number(timeoutText.trim() || item.schedule?.timeoutSeconds || 300);
		await applyUiChanges([{ action: "set_schedule", id: item.id, every, schedule_action: "command", command, cwd: cwd?.trim() || undefined, timeout_seconds: timeout }], ctx);
		if (await ctx.ui.confirm("Run now?", "Test the command once now?")) {
			const { run } = await runWatch(item.id, ctx.cwd);
			ctx.ui.notify(formatRunResult(item, run), run.status === "success" ? "info" : "warning");
		}
	}

	async function applyUiChanges(changes: TodoChange[], ctx: ExtensionContext): Promise<void> {
		const next = await serialize(() => applyTodoChanges(state, changes));
		persist(next, ctx);
	}

	pi.on("context", (event) => {
		if (!state.enabled) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "todo-state-context",
					content: formatAgentTodoContext(state),
					display: false,
					timestamp: Date.now(),
				},
			] as typeof event.messages,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		shuttingDown = false;
		state = restoreTodoState(ctx.sessionManager.getBranch());
		if (state.enabled) {
			ensureToolRegistered();
			activateTool();
			scheduler.start(state);
			updateWidget();
		} else {
			deactivateTool();
			ctx.ui.setWidget("todo", undefined);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		latestContext = ctx;
		state = restoreTodoState(ctx.sessionManager.getBranch());
		if (state.enabled) scheduler.start(state);
		refreshRuntime(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		wakeQueue.clear();
		scheduler.stop();
		runner.cancelAll();
		ctx.ui.setWidget("todo", undefined);
	});
}

function todoResult(op: "view" | "apply", state: TodoState) {
	return {
		content: [{ type: "text" as const, text: formatTodoState(state) }],
		details: { op, state: cloneTodoState(state) },
	};
}

class WakeQueue {
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly send: (content: string) => void) {}

	add(content: string): void {
		this.pending.push(content);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), 250);
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = [];
	}

	private flush(): void {
		this.timer = undefined;
		const messages = this.pending.splice(0);
		if (messages.length === 0) return;
		this.send(messages.length === 1 ? messages[0]! : `${messages.length} todo events are ready.\n\n${messages.map((message, index) => `## ${index + 1}\n${message}`).join("\n\n")}`);
	}
}
