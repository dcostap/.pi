import {
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateTail,
	type BashOperations,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { highlightBashCommand } from "../_shared/bash-command-highlight.ts";
import type { WaitInterruptRegistry } from "../_shared/wait-interrupt.ts";
import type { BackgroundProcessManager, BackgroundProcessSnapshot } from "./manager.ts";
import {
	BASH_TIMEOUT_DESCRIPTION,
	bashToolDescription,
	MAX_BLOCKING_SECONDS,
	stripBackgroundNotice,
	titleFromCommand,
	withBackgroundNotice,
} from "./prompt.ts";
import { asBashTransfer, renderBashTransferLine, type BashTransferView } from "./ui/tool-call.ts";

const ABORT_SETTLE_MS = 5_000;

type BashDefinition = ReturnType<typeof createBashToolDefinition>;
type RenderCall = NonNullable<BashDefinition["renderCall"]>;
type RenderResult = NonNullable<BashDefinition["renderResult"]>;

/** Thrown through Pi's bash implementation when a running command moves to the background. */
export class BashTransfer extends Error {
	constructor(
		readonly snapshot: BackgroundProcessSnapshot,
		readonly reason: BashTransferView["reason"],
		readonly timeoutSeconds: number,
	) {
		super(`moved to background as ${snapshot.id}`);
		this.name = "BashTransfer";
	}
}

export interface ForegroundBashDependencies {
	manager(ctx: ExtensionContext): BackgroundProcessManager;
	interrupts: WaitInterruptRegistry;
}

/** Effective blocking time for a requested bash timeout: never more than MAX_BLOCKING_SECONDS. */
export function effectiveTimeoutSeconds(requested: number | undefined): number {
	if (requested === undefined) return MAX_BLOCKING_SECONDS;
	if (!Number.isFinite(requested) || requested <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return Math.min(requested, MAX_BLOCKING_SECONDS);
}

/**
 * Pi's bash tool with one change: a command still running at the timeout, or when the user steers,
 * is adopted by the background registry instead of being killed. Everything else (output
 * accumulation, truncation, PI_* environment, rendering) is Pi's own implementation.
 */
export function createForegroundBashTool(dependencies: ForegroundBashDependencies) {
	const builtin = createBashToolDefinition(process.cwd());
	const builtinRenderResult = builtin.renderResult!;

	return {
		...builtin,
		description: bashToolDescription(builtin.description),
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: BASH_TIMEOUT_DESCRIPTION })),
		}),
		outputSchema: Type.Object({
			output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
			truncated: Type.Boolean(),
			full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
			exit_code: Type.Optional(Type.Number({ description: "Absent when the command is still running in the background" })),
			wall_time_seconds: Type.Number(),
			background_id: Type.Optional(Type.String({ description: "Background process ID when the command was moved to the background" })),
		}),

		async execute(...[toolCallId, params, signal, onUpdate, ctx]: Parameters<BashDefinition["execute"]>) {
			const timeoutSeconds = effectiveTimeoutSeconds(params.timeout);
			const operations = foregroundOperations(dependencies.manager(ctx), dependencies.interrupts, params.command, timeoutSeconds);
			const definition = createBashToolDefinition(ctx.cwd, { operations });
			try {
				return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
			} catch (error) {
				if (error instanceof BashTransfer) return transferResult(error);
				throw error;
			}
		},

		renderCall(...[args, theme, context]: Parameters<RenderCall>) {
			// Keep the timing state that Pi's bash result renderer reads.
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const command = typeof args?.command === "string" ? args.command : "";
			const commandDisplay = command ? highlightBashCommand(command) : theme.fg("toolOutput", "...");
			const timeout = typeof args?.timeout === "number" && args.timeout > 0
				? theme.fg("muted", ` (timeout ${Math.min(args.timeout, MAX_BLOCKING_SECONDS)}s)`)
				: "";
			component.setText(theme.fg("toolTitle", theme.bold("$ ")) + commandDisplay + timeout);
			return component;
		},

		renderResult(...[result, options, theme, context]: Parameters<RenderResult>) {
			const transfer = asBashTransfer((result.details as { background?: unknown } | undefined)?.background);
			if (!transfer) return builtinRenderResult(result, options, theme, context);
			const shown = {
				...result,
				content: result.content.map((item) => item.type === "text" ? { ...item, text: stripBackgroundNotice(item.text) } : item),
			};
			const component = builtinRenderResult(shown, options, theme, context);
			// Pi's bash renderer returns a Container; add the transfer line below its output.
			if ("addChild" in component && typeof component.addChild === "function") {
				(component as Container).addChild(renderBashTransferLine(transfer, theme));
			}
			return component;
		},
	};
}

function foregroundOperations(
	manager: BackgroundProcessManager,
	interrupts: WaitInterruptRegistry,
	displayCommand: string,
	timeoutSeconds: number,
): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, env }) {
			if (signal?.aborted) throw new Error("aborted");
			const launched = manager.launch(command, cwd, { env, onData });
			const interrupt = interrupts.begin(signal);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const outcome = await new Promise<"settled" | "timeout" | "steer" | "abort">((resolve) => {
					launched.execution.then(() => resolve("settled"), () => resolve("settled"));
					timer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000);
					const onInterrupt = () => resolve(interrupt.reason() === "steer" ? "steer" : "abort");
					if (interrupt.signal.aborted) onInterrupt();
					else interrupt.signal.addEventListener("abort", onInterrupt, { once: true });
				});

				if (outcome === "settled") {
					// Pi's bash implementation reports this output; drop the duplicate copy.
					launched.output.discard();
					return await launched.execution;
				}
				if (outcome === "abort" || manager.isDisposed()) {
					launched.abort();
					await Promise.race([launched.execution.catch(() => {}), delay(ABORT_SETTLE_MS)]);
					launched.output.discard();
					throw new Error("aborted");
				}

				launched.forward = undefined;
				const snapshot = manager.adopt(launched, titleFromCommand(displayCommand), outcome === "timeout" ? "bash-timeout" : "bash-steer");
				throw new BashTransfer(snapshot, outcome, timeoutSeconds);
			} finally {
				if (timer) clearTimeout(timer);
				interrupt.dispose();
			}
		},
	};
}

function transferResult(transfer: BashTransfer) {
	const { snapshot, reason, timeoutSeconds } = transfer;
	const output = snapshot.output;
	const tail = truncateTail(output.text.replace(/\s+$/u, ""), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const truncated = tail.truncated || output.truncated;
	let text = tail.content || "(no output yet)";
	if (truncated && output.fullOutputPath) {
		text += `\n\n[Showing the newest ${tail.outputLines} lines so far. Full output (still growing): ${output.fullOutputPath}]`;
	}
	const background: BashTransferView = { id: snapshot.id, reason, timeoutSeconds };
	const cause = reason === "timeout"
		? { kind: "bash-timeout" as const, id: snapshot.id, seconds: timeoutSeconds }
		: { kind: "bash-steer" as const, id: snapshot.id };
	return {
		content: [{ type: "text" as const, text: withBackgroundNotice(text, cause) }],
		details: {
			background,
			truncation: tail.truncated ? tail : undefined,
			fullOutputPath: output.fullOutputPath,
		},
		structuredContent: {
			output: output.text,
			truncated,
			...(truncated && output.fullOutputPath ? { full_output_path: output.fullOutputPath } : {}),
			wall_time_seconds: Math.round((Date.now() - snapshot.createdAt) / 100) / 10,
			background_id: snapshot.id,
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
