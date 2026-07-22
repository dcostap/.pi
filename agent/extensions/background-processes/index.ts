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
} from "./formatting.ts";
import { BackgroundProcessManager, WaitAbortedError } from "./manager.ts";
import { BACKGROUND_PROCESS_PROMPT, normalizeTitle } from "./prompt.ts";
import { ResultDeliveryCoordinator } from "./result-delivery.ts";
import { ProcessDashboard } from "./ui/process-dashboard.ts";
import { renderBackgroundToolCall, renderBackgroundToolResult } from "./ui/tool-call.ts";

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
	let widgetRunningCount = -1;
	let shuttingDown = false;

	const updateWidget = () => {
		const ctx = latestContext;
		if (!ctx?.hasUI) return;
		const running = manager?.runningCount ?? 0;
		if (running === widgetRunningCount) return;
		widgetRunningCount = running;
		ctx.ui.setWidget(
			"background-processes",
			running > 0 ? [`■ ${running} background process${running === 1 ? "" : "es"} running • /ps to view`] : undefined,
		);
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
			if (event.kind === "started" || event.kind === "settled" || event.kind === "pruned") updateWidget();
		});
		updateWidget();
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
			return renderBackgroundToolCall("bash_bg_start", args, theme, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_start", result, options, theme, context.lastComponent as Text | undefined, context.isError);
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
			return renderBackgroundToolCall("bash_bg_status", args, theme, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_status", result, options, theme, context.lastComponent as Text | undefined, context.isError);
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
		description: "List tracked background bash processes without waiting or including bash command output.",
		parameters: Type.Object({}),
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_list", args, theme, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_list", result, options, theme, context.lastComponent as Text | undefined, context.isError);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			const snapshots = manager?.list() ?? [];
			return {
				content: [{ type: "text", text: formatList(snapshots) }],
				details: { processes: snapshots.map(compactDetails) },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_wait",
		label: "bash background wait",
		description: "Wait for selected background bash processes to settle while streaming a bounded live output preview. Timeout or cancellation leaves them running.",
		parameters: WaitParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_wait", args, theme, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_wait", result, options, theme, context.lastComponent as Text | undefined, context.isError);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const activeManager = requireManager(ctx);
			try {
				const result = await activeManager.wait(params.ids, {
					timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
					signal,
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
					throw new Error("Background wait aborted; all unfinished processes are still running");
				}
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "bash_bg_kill",
		label: "bash background stop",
		description: "Request termination of selected background bash processes through the same local backend as Pi's built-in bash tool.",
		parameters: IdsParameters,
		renderCall(args, theme, context) {
			return renderBackgroundToolCall("bash_bg_kill", args, theme, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderBackgroundToolResult("bash_bg_kill", result, options, theme, context.lastComponent as Text | undefined, context.isError);
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
				{ overlay: true },
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
	});

	pi.on("agent_settled", async (_event, ctx) => {
		latestContext = ctx;
		delivery?.flushWhenIdle();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		latestContext = ctx;
		shuttingDown = true;
		delivery?.dispose();
		delivery = undefined;
		managerWidgetSubscription?.();
		managerWidgetSubscription = undefined;
		if (ctx.hasUI) ctx.ui.setWidget("background-processes", undefined);
		const activeManager = manager;
		manager = undefined;
		widgetRunningCount = -1;
		if (activeManager) await activeManager.dispose(5000);
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
