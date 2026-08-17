const MESSAGE_UPDATE_PREFIX = "{\"type\":\"message_update\",";
const TOOL_UPDATE_PREFIX = "{\"type\":\"tool_execution_update\",";

const UNUSED_MESSAGE_DELTAS = [
	"\"assistantMessageEvent\":{\"type\":\"thinking_delta\"",
	"\"assistantMessageEvent\":{\"type\":\"text_delta\"",
	"\"assistantMessageEvent\":{\"type\":\"toolcall_delta\"",
] as const;

/**
 * Identify high-volume RPC events that managed subagents do not consume.
 *
 * This deliberately matches only Pi's canonical JSON.stringify output. Any
 * protocol shape or property-order change falls back to normal JSON parsing.
 */
export function isUnusedRpcStreamEvent(line: string): boolean {
	if (line.startsWith(TOOL_UPDATE_PREFIX)) return true;
	if (!line.startsWith(MESSAGE_UPDATE_PREFIX)) return false;
	return UNUSED_MESSAGE_DELTAS.some((marker) => line.includes(marker));
}
