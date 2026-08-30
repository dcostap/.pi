import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatKillResults,
	formatList,
	formatProcess,
	formatStartResult,
	formatWaitUpdate,
	formatWaitResult,
	recentListSnapshots,
} from "./formatting.ts";
import { BackgroundProcessManager, WaitAbortedError } from "./manager.ts";
import { BACKGROUND_PROCESS_PROMPT, normalizeTitle } from "./prompt.ts";
import { ResultDeliveryCoordinator } from "./result-delivery.ts";
import { ProcessDashboard } from "./ui/process-dashboard.ts";
import { processWidgetComponent } from "./ui/process-widget.ts";
import {
	renderBackgroundToolCall,
	renderBackgroundToolResult,
	type BackgroundProcessLookup,
} from "./ui/tool-call.ts";
import { MANAGED_WORK_STATE_EVENT } from "../_shared/managed-work.ts";
import { WaitInterruptRegistry } from "./wait-interrupt.ts";

const StartParameters = Type.Object({
	command: Type.String({ minLength: 1, description: "Non-interactive bash command to run using the same local backend as Pi's built-in bash tool" }),
	title: Type.String({ minLength: 1, description: "Short human-readable title (maximum 80 characters)" }),
	working_dir: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
});

const IdParameters = Type.Object({
	id: Type.String({ minLength: 1, description: "Background bash process ID returned by bash_bg_start" }),
});

const IdsParameters = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "Background bash process IDs" }),
});

const WaitParameters = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "Background bash process IDs" }),
	timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400, description: "Maximum wait in seconds" })),
});

export default function backgroundProcessesExtension(pi: ExtensionAPI) {
	let manager: BackgroundProcessManager | undefined;
	let delivery: ResultDeliveryCoordinator | undefined;
	let managerWidgetSubscription: (() => void) | undefined;
	let latestContext: ExtensionContext | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetLastRefreshAt = 0;
	let shuttingDown = false;
	const waitInterrupts = new WaitInterruptRegistry();

	const publishManagedWork = () => {
		const pending = manager?.list().some((snapshot) => !snapshot.settled) ?? false;
		pi.events.emit(MANAGED_WORK_STATE_EVENT, { source: "background-processes", pending });
	};

	const updateWidget = () => {
		const ctx = latestContext;
		if (!ctx || ctx.mode !== "tui" || shuttingDown) return;
		const running = manager?.list().filter((snapshot) => !snapshot.settled) ?? [];
		ctx.ui.setWidget("background-processes", running.length > 0
			? (tui, theme) => processWidgetComponent(running, theme, tui)
			: undefined);
		widgetLastRefreshAt = Date.now();
		if (running.length > 0 && !widgetTimer) widgetTimer = setInterval(updateWidget, 1_000);
		else if (running.length === 0 && widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
	};

	const scheduleWidgetUpdate = () => {
		if (widgetRefreshTimer || shuttingDown) return;
		const delay = Math.max(0, 250 - (Date.now() - widgetLastRefreshAt));
		widgetRefreshTimer = setTimeout(() => {
			widgetRefreshTimer = undefined;
			updateWidget();
		}, delay);
	};

	const ensureManager = (ctx: ExtensionContext): BackgroundProcessManager => {
		latestContext = ctx;
		if (shuttingDown) throw new Error("Background process extension is shutting down");
		if (manager) return manager;

		manager = new BackgroundProcessManager(createLocalBashOperations());
		delivery = new ResultDeliveryCoordinator(manager, {
			isIdle: () => !shuttingDown && Boolean(latestContext?.isIdle()),
			send: (message) => {
				pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
			},
		});
		managerWidgetSubscription = manager.subscribe((event) => {
			if (event.kind === "output") scheduleWidgetUpdate();
			else if (event.kind === "started" || event.kind === "settled" || event.kind === "pruned") {
				updateWidget();
				publishManagedWork();
			}
		});
		updateWidget();
		publishManagedWork();
		return manager;
	};

	const requireManager = (ctx: ExtensionContext): BackgroundProcessManager => {
		latestContext = ctx;
		if (!manager) throw new Error("No background processes have been started in this session");
		return manager;
	};

	pi.registerTool({
		name: "bash_bg_start",
		label: "bash background start",
		description: `Start a long-running non-interactive bash command using the same local backend as Pi's built-in bash tool and return immediately. Recent merged output is retained in bounded memory. Output beyond Pi's standard 50KB/2000-line inline limit is saved to a temporary full-output file.\n\n${BACKGROUND_PROCESS_PROMPT}`,
		promptSnippet: "Start a long non-interactive bash command in the background; completion is delivered automatically",
		parameters: StartParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_start", args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_start", result, options, theme, context.lastComponent as Text | undefined, context.isError, processLookup(manager, result.details));
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background start aborted before launch");
			const command = params.command.trim();
			if (!command) throw new Error("command must not be empty");
			const title = normalizeTitle(params.title);
			if (!title) throw new Error("title must not be empty");
			const rawWorkingDirectory = params.working_dir?.replace(/^@(?=[A-Za-z]:[\\/]|[./\\])/u, "") ?? ctx.cwd;
			const cwd = resolve(ctx.cwd, rawWorkingDirectory);
			let info;
			try {
				info = await stat(cwd);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
			if (signal?.aborted) throw new Error("Background start aborted before launch");

			const started = ensureManager(ctx).start(command, title, cwd);
			return {
				content: [{ type: "text", text: formatStartResult(started) }],
				details: { id: started.id, title, cwd, status: started.status },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_status",
		label: "bash background status",
		description: "Return a nonblocking status and bounded recent-output snapshot for one background bash process.",
		parameters: IdParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_status", args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_status", result, options, theme, context.lastComponent as Text | undefined, context.isError, processLookup(manager, result.details));
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = requireManager(ctx).get(params.id, true);
			return {
				content: [{ type: "text", text: formatProcess(snapshot) }],
				details: compactDetails(snapshot),
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_list",
		label: "bash background list",
		description: "List the 30 most recent tracked background bash processes without waiting or including bash command output. Older entries are summarized.",
		parameters: Type.Object({}),
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_list", args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_list", result, options, theme, context.lastComponent as Text | undefined, context.isError, processLookup(manager, result.details));
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			const snapshots = manager?.list() ?? [];
			const visible = recentListSnapshots(snapshots);
			return {
				content: [{ type: "text", text: formatList(snapshots) }],
				details: { processes: visible.map(compactDetails), omitted: snapshots.length - visible.length },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_wait",
		label: "bash background wait",
		description: "Wait for selected background bash processes. The tool streams a bounded live output preview. A steering message interrupts only the wait. Timeout, steering, or cancellation leaves unfinished processes running.",
		parameters: WaitParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_wait", args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_wait", result, options, theme, context.lastComponent as Text | undefined, context.isError, processLookup(manager, result.details));
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const activeManager = requireManager(ctx);
			const wait = waitInterrupts.begin(signal);
			try {
				const result = await activeManager.wait(params.ids, {
					timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
					signal: wait.signal,
					updateIntervalMs: 100,
					onUpdate: (runningIds, snapshots) => {
						onUpdate?.({
							content: [{ type: "text", text: formatWaitUpdate(snapshots) }],
							details: {
								runningIds,
								processes: snapshots.map(compactDetails),
							},
						});
					},
				});
				return {
					content: [{ type: "text", text: formatWaitResult(result) }],
					details: {
						timedOut: result.timedOut,
						settled: result.settled.map(compactDetails),
						runningIds: result.runningIds,
					},
				};
			} catch (error) {
				if (error instanceof WaitAbortedError) {
					if (wait.reason() === "steer") {
						const snapshots = params.ids.map((id) => activeManager.get(id));
						return {
							content: [{ type: "text", text: "Background wait interrupted by a steering message. Unfinished processes remain active." }],
							details: {
								interruptedBySteer: true,
								processes: snapshots.map(compactDetails),
								runningIds: snapshots.filter((snapshot) => !snapshot.settled).map((snapshot) => snapshot.id),
							},
						};
					}
					throw new Error("Background wait aborted; all unfinished processes are still running");
				}
				throw error;
			} finally {
				wait.dispose();
			}
		},
	});

	pi.on("input", (event) => {
		if (event.streamingBehavior !== "steer") return;
		waitInterrupts.interruptForSteer();
	});

	pi.registerTool({
		name: "bash_bg_kill",
		label: "bash background stop",
		description: "Request termination of selected background bash processes through the same local backend as Pi's built-in bash tool.",
		parameters: IdsParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_kill", args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_kill", result, options, theme, context.lastComponent as Text | undefined, context.isError, processLookup(manager, result.details));
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background stop aborted before termination began");
			const results = await requireManager(ctx).kill(params.ids, 5000);
			return {
				content: [{ type: "text", text: formatKillResults(results) }],
				details: { results: results.map(({ id, outcome, snapshot }) => ({ id, outcome, ...compactDetails(snapshot) })) },
			};
		},
	});

	pi.registerCommand("ps", {
		description: "Inspect and stop extension-managed background processes",
		handler: async (_args, ctx) => {
			latestContext = ctx;
			if (!manager || manager.size === 0) {
				if (ctx.hasUI) ctx.ui.notify("No background processes are tracked.", "info");
				return;
			}
			if (ctx.mode === "rpc") {
				ctx.ui.notify(formatList(manager.list()), "info");
				return;
			}
			if (ctx.mode !== "tui") return;

			const activeManager = manager;
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					new ProcessDashboard(activeManager, theme, keybindings, () => tui.requestRender(), () => done(undefined)),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "85%",
						minWidth: 64,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
		},
	});

	pi.registerMessageRenderer("background-process-result", (message, { expanded }, theme) => {
		const text = expanded ? message.content : message.content.split("\n").slice(0, 8).join("\n");
		const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(theme.fg("accent", theme.bold("Background process result")) + `\n${text}`, 0, 0));
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		shuttingDown = false;
		updateWidget();
		publishManagedWork();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		latestContext = ctx;
		delivery?.flushWhenIdle();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		latestContext = ctx;
		shuttingDown = true;
		waitInterrupts.abortAll();
		delivery?.dispose();
		delivery = undefined;
		managerWidgetSubscription?.();
		managerWidgetSubscription = undefined;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		if (widgetRefreshTimer) clearTimeout(widgetRefreshTimer);
		widgetRefreshTimer = undefined;
		if (ctx.hasUI) ctx.ui.setWidget("background-processes", undefined);
		const activeManager = manager;
		manager = undefined;
		widgetLastRefreshAt = 0;
		if (activeManager) await activeManager.dispose(5000);
		pi.events.emit(MANAGED_WORK_STATE_EVENT, { source: "background-processes", pending: false });
	});
}

function compactDetails(snapshot: ReturnType<BackgroundProcessManager["get"]>) {
	return {
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status,
		cwd: snapshot.cwd,
		createdAt: snapshot.createdAt,
		settledAt: snapshot.settledAt,
		exitCode: snapshot.exitCode,
		killRequested: snapshot.killRequested,
		capturedBytes: snapshot.output.totalBytes,
		droppedBytes: snapshot.output.droppedBytes,
		totalLines: snapshot.output.totalLines,
		fullOutputPath: snapshot.output.fullOutputPath,
	};
}

function processLookup(manager: BackgroundProcessManager | undefined, details?: unknown): BackgroundProcessLookup {
	return (id) => {
		const live = manager?.list().find((snapshot) => snapshot.id === id);
		if (live) return { title: live.title, command: live.command };
		return findProcessInDetails(details, id);
	};
}

function findProcessInDetails(
	value: unknown,
	id: string,
): { title: string | undefined; command: string | undefined } | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findProcessInDetails(item, id);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.id === id && typeof record.title === "string") {
		return { title: record.title, command: undefined };
	}
	for (const key of ["processes", "settled", "results"]) {
		const found = findProcessInDetails(record[key], id);
		if (found) return found;
	}
	return undefined;
}
