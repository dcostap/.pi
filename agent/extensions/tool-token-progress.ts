import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { linkFile } from "./_shared/file-links.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const OUTPUT_ARROW = "↓";
const TRACKED_TOOLS = new Set(["edit", "write"]);

const outputCharsByToolCallId = new Map<string, number>();

function stringifyArgs(args: unknown): string {
	if (typeof args === "string") return args;
	if (args === undefined || args === null) return "";
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function estimateTokensFromChars(chars: number): number {
	return Math.max(0, Math.ceil(chars / 4));
}

function estimateTokens(args: unknown, toolCallId?: string): number {
	const streamedChars = toolCallId ? (outputCharsByToolCallId.get(toolCallId) ?? 0) : 0;
	const serializedArgs = stringifyArgs(args);
	const serializedChars = serializedArgs === "{}" ? 0 : serializedArgs.length;
	return estimateTokensFromChars(Math.max(streamedChars, serializedChars));
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));

	const thousands = tokens / 1000;
	if (thousands < 10) {
		return `${Number(thousands.toFixed(1))}k`;
	}

	return `${Math.round(thousands)}k`;
}

function stringArg(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(filePath: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function formatToolHeader(toolName: "edit" | "write", args: any, theme: Theme, cwd: string): string {
	const rawPath = stringArg(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const target = rawPath === "~" ? homedir() : rawPath?.startsWith("~/") || rawPath?.startsWith("~\\") ? join(homedir(), rawPath.slice(2)) : rawPath;
	const pathDisplay = path === null
		? theme.fg("error", "[invalid arg]")
		: path
			? linkFile(theme.fg("accent", path), target!, cwd)
			: theme.fg("toolOutput", "...");

	return `${theme.fg("toolTitle", theme.bold(toolName))} ${pathDisplay}`;
}

const tokenSuffixes = new WeakMap<Text, string>();

// Keep the native header and its file link. Replace only our own token suffix.
function appendTokenSuffix(component: Text, suffix: string): void {
	const text = (component as any).text;
	if (typeof text !== "string") return;
	const newline = text.indexOf("\n");
	let header = newline === -1 ? text : text.slice(0, newline);
	const previous = tokenSuffixes.get(component);
	if (previous && header.endsWith(previous)) header = header.slice(0, -previous.length);
	component.setText(`${header}${suffix}${newline === -1 ? "" : text.slice(newline)}`);
	tokenSuffixes.set(component, suffix);
}

function patchHeader(
	component: Component | undefined,
	args: unknown,
	theme: Theme,
	toolCallId?: string,
): void {
	const tokens = estimateTokens(args, toolCallId);
	const suffix = tokens > 0 ? ` ${theme.fg("dim", `${OUTPUT_ARROW}${formatTokens(tokens)}`)}` : "";

	if (component instanceof Text) {
		appendTokenSuffix(component, suffix);
		return;
	}

	const maybeContainer = component as { children?: unknown[] } | undefined;
	const firstChild = maybeContainer?.children?.[0];
	if (firstChild instanceof Text) {
		appendTokenSuffix(firstChild, suffix);
	}
}

function toolCallFromEvent(event: AssistantMessageEvent): { id: string; name: string } | undefined {
	if (event.type === "toolcall_end") {
		return { id: event.toolCall.id, name: event.toolCall.name };
	}

	if (event.type !== "toolcall_delta" && event.type !== "toolcall_start") return undefined;

	const block = event.partial.content[event.contentIndex];
	if (!block || block.type !== "toolCall") return undefined;
	return { id: block.id, name: block.name };
}

export default function (pi: ExtensionAPI) {
	// Allow a separate extension to supply write filesystem operations without
	// coupling this rendering extension to any platform-specific workaround.
	let writeOperations: WriteOperations | undefined;
	pi.events.on("write-operations:available", (operations: unknown) => {
		const candidate = operations as Partial<WriteOperations> | undefined;
		if (typeof candidate?.mkdir === "function" && typeof candidate?.writeFile === "function") {
			writeOperations = candidate as WriteOperations;
		}
	});
	pi.events.emit("write-operations:request", undefined);

	pi.on("agent_start", () => {
		outputCharsByToolCallId.clear();
	});

	pi.on("message_update", (event) => {
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type !== "toolcall_delta") return;

		const toolCall = toolCallFromEvent(streamEvent);
		if (!toolCall || !TRACKED_TOOLS.has(toolCall.name)) return;

		outputCharsByToolCallId.set(
			toolCall.id,
			(outputCharsByToolCallId.get(toolCall.id) ?? 0) + streamEvent.delta.length,
		);
	});

	pi.on("session_start", (_event, ctx) => {
		const baseEdit = createEditToolDefinition(ctx.cwd);
		const baseWrite = createWriteToolDefinition(
			ctx.cwd,
			writeOperations ? { operations: writeOperations } : undefined,
		);

		pi.registerTool({
			...baseEdit,
			renderCall(args, theme, context) {
				const component = baseEdit.renderCall
					? baseEdit.renderCall(args, theme, context)
					: new Text(formatToolHeader("edit", args, theme, context.cwd), 0, 0);
				patchHeader(component, args, theme, context.toolCallId);
				return component;
			},
			renderResult(result, options, theme, context) {
				const component = baseEdit.renderResult
					? baseEdit.renderResult(result, options, theme, context)
					: new Text("", 0, 0);
				patchHeader(context.state?.callComponent as Component | undefined, context.args, theme, context.toolCallId);
				return component;
			},
		});

		pi.registerTool({
			...baseWrite,
			renderCall(args, theme, context) {
				const component = baseWrite.renderCall
					? baseWrite.renderCall(args, theme, context)
					: new Text(formatToolHeader("write", args, theme, context.cwd), 0, 0);
				patchHeader(component, args, theme, context.toolCallId);
				return component;
			},
		});
	});

	pi.on("agent_end", () => {
		outputCharsByToolCallId.clear();
	});
}
