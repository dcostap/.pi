import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createForegroundBashTool } from "./foreground-bash.ts";
import {
	formatAutomaticResults,
	formatKillResults,
	formatList,
	formatProcess,
	formatStartResult,
	formatWaitUpdate,
	formatWaitResult,
	processView,
	recentListSnapshots,
} from "./formatting.ts";
import { BackgroundProcessManager, WaitAbortedError } from "./manager.ts";
import { BACKGROUND_PROCESS_PROMPT, MAX_BLOCKING_SECONDS, normalizeTitle, withBackgroundNotice } from "./prompt.ts";
import { ResultDeliveryCoordinator } from "./result-delivery.ts";
import { ProcessDashboard } from "./ui/process-dashboard.ts";
import { processWidgetComponent } from "./ui/process-widget.ts";
import {
	renderBackgroundCompletionMessage,
	renderBackgroundToolCall,
	renderBackgroundToolResult,
	type BackgroundProcessLookup,
	type BackgroundToolName,
} from "./ui/tool-call.ts";
import { MANAGED_WORK_STATE_EVENT } from "../_shared/managed-work.ts";
import { WaitInterruptRegistry } from "../_shared/wait-interrupt.ts";

const StartParameters = Type.Object({
	command: Type.String({ minLength: 1, description: "Non-interactive bash command to run using the same local backend as Pi's built-in bash tool" }),
	title: Type.String({ minLength: 1, description: "Short human-readable title (maximum 80 characters)" }),
	working_dir: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
});

const StatusParameters = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, description: "Background bash process ID. Omit to list recent processes." })),
});

const IdsParameters = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "Background bash process IDs" }),
});

const WaitParameters = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "Background bash process IDs" }),
	timeout_seconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 86_400,
		description: `Maximum wait in seconds. Defaults to and is capped at ${MAX_BLOCKING_SECONDS}.`,
	})),
});

const START_GRACE_MS = 2_000;

export default function backgroundProcessesExtension(pi: ExtensionAPI) {
	let manager: BackgroundProcessManager | undefined;
	let delivery: ResultDeliveryCoordinator | undefined;
	let managerWidgetSubscription: (() => void) | undefined;
	let latestContext: ExtensionContext | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetLastRefreshAt = 0;
	let shuttingDown = false;
	const interrupts = new WaitInterruptRegistry();

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

	const renderers = (toolName: BackgroundToolName) => ({
		renderCall(args: Record<string, unknown>, theme: Theme, context: { lastComponent?: unknown }) {
			return renderBackgroundToolCall(toolName, args, theme, context.lastComponent as Text | undefined, processLookup(manager));
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: unknown },
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: { lastComponent?: unknown; isError?: boolean },
		) {
			return renderBackgroundToolResult(toolName, result, options, theme, context.lastComponent as Component | undefined, context.isError);
		},
	});

	pi.registerTool(createForegroundBashTool({ manager: ensureManager, interrupts }));

	pi.registerTool({
		name: "bash_bg_start",
		label: "bash background start",
		description: `Start a long-running non-interactive bash command using the same local backend as Pi's built-in bash tool. Wait up to two seconds for completion. Return the completion result if it finishes, or its background ID if it remains active. Recent merged output is retained in bounded memory. Output beyond Pi's standard 50KB/2000-line inline limit is saved to a temporary full-output file.\n\n${BACKGROUND_PROCESS_PROMPT}`,
		promptSnippet: "Start a long non-interactive bash command; wait two seconds for a quick result, then deliver later completion automatically",
		parameters: StartParameters,
		...renderers("bash_bg_start"),
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

			const started = await ensureManager(ctx).startWithGracePeriod(command, title, cwd, START_GRACE_MS, signal);
			return {
				content: [{ type: "text", text: started.settled ? formatAutomaticResults([started]) : formatStartResult(started) }],
				details: { process: processView(started) },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_status",
		label: "bash background status",
		description: "Without waiting, return the status and recent output of one background bash process. Omit id to list the 30 most recent processes without their output.",
		parameters: StatusParameters,
		...renderers("bash_bg_status"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			if (params.id === undefined) {
				const snapshots = manager?.list() ?? [];
				const visible = recentListSnapshots(snapshots);
				return {
					content: [{ type: "text", text: formatList(snapshots) }],
					details: {
						processes: visible.map((snapshot) => processView(snapshot, { preview: false })),
						omitted: snapshots.length - visible.length,
					},
				};
			}
			const snapshot = requireManager(ctx).get(params.id, true);
			return {
				content: [{ type: "text", text: formatProcess(snapshot) }],
				details: { process: processView(snapshot) },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_wait",
		label: "bash background wait",
		description: `Wait for selected background bash processes, at most ${MAX_BLOCKING_SECONDS} seconds per call. The tool streams a bounded live output preview. A steering message interrupts only the wait. Timeout, steering, or cancellation leaves unfinished processes running.`,
		parameters: WaitParameters,
		...renderers("bash_bg_wait"),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const activeManager = requireManager(ctx);
			const timeoutSeconds = Math.min(params.timeout_seconds ?? MAX_BLOCKING_SECONDS, MAX_BLOCKING_SECONDS);
			const wait = interrupts.begin(signal);
			try {
				const result = await activeManager.wait(params.ids, {
					timeoutMs: timeoutSeconds * 1000,
					signal: wait.signal,
					updateIntervalMs: 100,
					onUpdate: (_runningIds, snapshots) => {
						onUpdate?.({
							content: [{ type: "text", text: formatWaitUpdate(snapshots) }],
							details: { processes: snapshots.map((snapshot) => processView(snapshot)) },
						});
					},
				});
				const text = formatWaitResult(result);
				return {
					content: [{
						type: "text",
						text: result.timedOut
							? withBackgroundNotice(text, { kind: "wait-timeout", ids: result.runningIds, seconds: timeoutSeconds })
							: text,
					}],
					details: {
						processes: activeManager.validateIds(params.ids).map((id) => processView(activeManager.get(id))),
						timedOut: result.timedOut,
						timeoutSeconds,
						runningIds: result.runningIds,
					},
				};
			} catch (error) {
				if (error instanceof WaitAbortedError) {
					if (wait.reason() === "steer") {
						const snapshots = activeManager.validateIds(params.ids).map((id) => activeManager.get(id));
						const runningIds = snapshots.filter((snapshot) => !snapshot.settled).map((snapshot) => snapshot.id);
						return {
							content: [{
								type: "text",
								text: withBackgroundNotice("Background wait interrupted by a steering message.", { kind: "wait-steer", ids: runningIds }),
							}],
							details: {
								interruptedBySteer: true,
								processes: snapshots.map((snapshot) => processView(snapshot)),
								runningIds,
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
		interrupts.interruptForSteer();
	});

	pi.registerTool({
		name: "bash_bg_kill",
		label: "bash background stop",
		description: "Request termination of selected background bash processes through the same local backend as Pi's built-in bash tool.",
		parameters: IdsParameters,
		...renderers("bash_bg_kill"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background stop aborted before termination began");
			const results = await requireManager(ctx).kill(params.ids, 5000);
			return {
				content: [{ type: "text", text: formatKillResults(results) }],
				details: {
					results: results.map(({ outcome, snapshot }) => ({ outcome, process: processView(snapshot, { preview: false }) })),
				},
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
		return renderBackgroundCompletionMessage(message, { expanded }, theme);
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
		interrupts.abortAll();
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

function processLookup(manager: BackgroundProcessManager | undefined): BackgroundProcessLookup {
	return (id) => {
		const live = manager?.list().find((snapshot) => snapshot.id === id);
		return live ? { title: live.title } : undefined;
	};
}
