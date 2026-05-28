import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

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

function formatToolHeader(toolName: "edit" | "write", args: any, theme: Theme, toolCallId?: string): string {
	const rawPath = stringArg(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null
		? theme.fg("error", "[invalid arg]")
		: path
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");

	const tokens = estimateTokens(args, toolCallId);
	const tokenDisplay = tokens > 0 ? ` ${theme.fg("dim", `${OUTPUT_ARROW}${formatTokens(tokens)}`)}` : "";

	return `${theme.fg("toolTitle", theme.bold(toolName))} ${pathDisplay}${tokenDisplay}`;
}

function replaceFirstLine(text: string, replacement: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? replacement : `${replacement}${text.slice(newline)}`;
}

function patchTextFirstLine(component: Text, header: string): void {
	const current = (component as any).text;
	component.setText(replaceFirstLine(typeof current === "string" ? current : "", header));
}

function patchHeader(
	toolName: "edit" | "write",
	component: Component | undefined,
	args: unknown,
	theme: Theme,
	toolCallId?: string,
): void {
	const header = formatToolHeader(toolName, args, theme, toolCallId);

	if (component instanceof Text) {
		patchTextFirstLine(component, header);
		return;
	}

	const maybeContainer = component as { children?: unknown[] } | undefined;
	const firstChild = maybeContainer?.children?.[0];
	if (firstChild instanceof Text) {
		firstChild.setText(header);
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
		const baseWrite = createWriteToolDefinition(ctx.cwd);

		pi.registerTool({
			...baseEdit,
			renderCall(args, theme, context) {
				const component = baseEdit.renderCall
					? baseEdit.renderCall(args, theme, context)
					: new Text(formatToolHeader("edit", args, theme, context.toolCallId), 0, 0);
				patchHeader("edit", component, args, theme, context.toolCallId);
				return component;
			},
			renderResult(result, options, theme, context) {
				const component = baseEdit.renderResult
					? baseEdit.renderResult(result, options, theme, context)
					: new Text("", 0, 0);
				patchHeader("edit", context.state?.callComponent as Component | undefined, context.args, theme, context.toolCallId);
				return component;
			},
		});

		pi.registerTool({
			...baseWrite,
			renderCall(args, theme, context) {
				const component = baseWrite.renderCall
					? baseWrite.renderCall(args, theme, context)
					: new Text(formatToolHeader("write", args, theme, context.toolCallId), 0, 0);
				patchHeader("write", component, args, theme, context.toolCallId);
				return component;
			},
		});
	});

	pi.on("agent_end", () => {
		outputCharsByToolCallId.clear();
	});
}
