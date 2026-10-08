// Converts a Claude Code transcript (JSONL rows) into Pi session entries.
// Pure: no file system access. sync.ts owns reading and writing files.
import { createHash } from "node:crypto";

export type CcRow = Record<string, any>;
export type PiEntry = Record<string, any>;

export type ConvertResult = {
	header: PiEntry;
	entries: PiEntry[];
	title?: string;
};

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const STOP_REASONS: Record<string, string> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "toolUse",
	max_tokens: "length",
	refusal: "stop",
	pause_turn: "stop",
};

export function parseJsonl(text: string): CcRow[] {
	const rows: CcRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value);
		} catch {
			// A partial last line can exist while Claude Code writes. Skip it.
		}
	}
	return rows;
}

/** Deterministic 8-hex entry ID, so a rebuilt mirror has the same IDs. */
export function entryId(key: string): string {
	return createHash("sha1").update(key).digest("hex").slice(0, 8);
}

function isConversationRow(row: CcRow): boolean {
	return typeof row.uuid === "string"
		&& !row.isSidechain
		&& (row.type === "user" || row.type === "assistant" || row.type === "system" || row.type === "attachment");
}

/**
 * Returns the rows on the active branch, oldest first.
 *
 * Walk parentUuid links back from the last row. A compaction boundary has no
 * parent; continue from the last row written before the boundary.
 */
export function activePath(rows: CcRow[]): CcRow[] {
	const byUuid = new Map<string, CcRow>();
	const position = new Map<string, number>();
	rows.forEach((row, index) => {
		if (!isConversationRow(row)) return;
		byUuid.set(row.uuid, row);
		position.set(row.uuid, index);
	});
	let current: CcRow | undefined;
	for (let index = rows.length - 1; index >= 0 && !current; index--) {
		if (isConversationRow(rows[index]!)) current = rows[index];
	}
	const path: CcRow[] = [];
	const visited = new Set<string>();
	while (current && !visited.has(current.uuid)) {
		visited.add(current.uuid);
		path.push(current);
		const parent = typeof current.parentUuid === "string" ? byUuid.get(current.parentUuid) : undefined;
		if (parent) current = parent;
		else if (current.type === "system" && current.subtype === "compact_boundary") current = lastRowBefore(rows, position.get(current.uuid)!, visited);
		else current = undefined;
	}
	return path.reverse();
}

function lastRowBefore(rows: CcRow[], index: number, visited: Set<string>): CcRow | undefined {
	for (let at = index - 1; at >= 0; at--) {
		const row = rows[at]!;
		if (isConversationRow(row) && !visited.has(row.uuid)) return row;
	}
	return undefined;
}

function msTimestamp(row: CcRow): number {
	const value = Date.parse(String(row.timestamp));
	return Number.isFinite(value) ? value : 0;
}

function isoTimestamp(row: CcRow): string {
	return new Date(msTimestamp(row)).toISOString();
}

function imageBlock(block: any): PiEntry | undefined {
	const source = block?.source;
	if (source?.type !== "base64" || typeof source.data !== "string") return undefined;
	return { type: "image", data: source.data, mimeType: source.media_type ?? "image/png" };
}

function userContent(content: unknown): string | PiEntry[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: PiEntry[] = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (block?.type === "image") {
			const image = imageBlock(block);
			if (image) blocks.push(image);
		}
	}
	return blocks;
}

function toolResultContent(content: unknown): PiEntry[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [{ type: "text", text: content === undefined ? "" : JSON.stringify(content) }];
	const blocks: PiEntry[] = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (block?.type === "image") {
			const image = imageBlock(block);
			if (image) blocks.push(image);
		} else blocks.push({ type: "text", text: JSON.stringify(block) });
	}
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * Maps Claude Code tool calls to the Pi built-in tool with the same job, so
 * Pi renders them with its own renderers. Other tools keep their names.
 */
export function mapToolCall(name: string, input: unknown): { name: string; arguments: Record<string, any> } {
	const args: Record<string, any> = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, any> : {};
	switch (name) {
		case "Bash":
			return {
				name: "bash",
				arguments: {
					command: args.command,
					...(typeof args.timeout === "number" ? { timeout: Math.max(1, Math.round(args.timeout / 1000)) } : {}),
				},
			};
		case "Read":
			return {
				name: "read",
				arguments: {
					path: args.file_path,
					...(args.offset !== undefined ? { offset: args.offset } : {}),
					...(args.limit !== undefined ? { limit: args.limit } : {}),
				},
			};
		case "Write":
			return { name: "write", arguments: { path: args.file_path, content: args.content } };
		case "Edit":
			return { name: "edit", arguments: { path: args.file_path, edits: [{ oldText: args.old_string, newText: args.new_string }] } };
		default:
			// The pi-bridge mod serves Pi's own subagent tools.
			return { name: name.replace(/^mcp__pi-bridge__/, ""), arguments: args };
	}
}

function usage(raw: any): PiEntry {
	const input = Number(raw?.input_tokens) || 0;
	const output = Number(raw?.output_tokens) || 0;
	const cacheRead = Number(raw?.cache_read_input_tokens) || 0;
	const cacheWrite = Number(raw?.cache_creation_input_tokens) || 0;
	const value: PiEntry = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const cacheWrite1h = Number(raw?.cache_creation?.ephemeral_1h_input_tokens);
	if (cacheWrite1h > 0) value.cacheWrite1h = cacheWrite1h;
	const reasoning = Number(raw?.output_tokens_details?.thinking_tokens);
	if (reasoning > 0) value.reasoning = reasoning;
	return value;
}

function assistantBlocks(content: unknown): PiEntry[] {
	if (!Array.isArray(content)) return [];
	const blocks: PiEntry[] = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (block?.type === "thinking") {
			blocks.push({ type: "thinking", thinking: String(block.thinking ?? ""), ...(block.signature ? { thinkingSignature: block.signature } : {}) });
		} else if (block?.type === "redacted_thinking") {
			blocks.push({ type: "thinking", thinking: "", thinkingSignature: String(block.data ?? ""), redacted: true });
		} else if (block?.type === "tool_use") {
			const mapped = mapToolCall(String(block.name), block.input);
			blocks.push({ type: "toolCall", id: String(block.id), name: mapped.name, arguments: mapped.arguments });
		}
	}
	return blocks;
}

function titleFrom(rows: CcRow[]): string | undefined {
	let custom: string | undefined;
	let ai: string | undefined;
	for (const row of rows) {
		if (row.type === "custom-title" && typeof row.customTitle === "string" && row.customTitle.trim()) custom = row.customTitle.trim();
		if (row.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) ai = row.aiTitle.trim();
	}
	return custom ?? ai;
}

/**
 * Converts one Claude Code transcript to Pi entries on one linear branch.
 * Returns undefined when the transcript has no user or assistant message.
 */
export function convertTranscript(rows: CcRow[], sessionId: string): ConvertResult | undefined {
	const path = activePath(rows);
	const first = path.find((row) => row.type === "user" || row.type === "assistant");
	if (!first) return undefined;

	const entries: PiEntry[] = [];
	const idForUuid = new Map<string, string>();
	let parentId: string | null = null;
	const push = (entry: PiEntry, sourceUuid?: string): PiEntry => {
		const full = { ...entry, parentId };
		entries.push(full);
		parentId = full.id;
		if (sourceUuid && !idForUuid.has(sourceUuid)) idForUuid.set(sourceUuid, full.id);
		return full;
	};

	// Claude Code writes one row per assistant content block. Rows with one
	// message.id form one Pi message. Tool results that arrive while that
	// message is open wait until it closes. Prompts queued mid-turn wait until
	// every tool call has a result, so Pi providers get a valid order.
	let open: { messageId: string; entry: PiEntry; rows: CcRow[] } | undefined;
	let heldResults: Array<{ entry: PiEntry; uuid: string }> = [];
	let heldPrompts: Array<{ entry: PiEntry; uuid: string }> = [];
	const callNames = new Map<string, string>();
	const unanswered = new Map<string, CcRow>();
	let model: string | undefined;
	let thinkingLevel: string | undefined;
	let lastBoundary: CcRow | undefined;

	const flushPrompts = () => {
		if (open || unanswered.size > 0) return;
		for (const item of heldPrompts) push(item.entry, item.uuid);
		heldPrompts = [];
	};

	const emitResult = (item: { entry: PiEntry; uuid: string }) => {
		unanswered.delete(item.entry.message.toolCallId);
		push(item.entry, item.uuid);
	};

	const closeAssistant = () => {
		if (!open) return;
		const last = open.rows[open.rows.length - 1]!;
		const content = open.rows.flatMap((row) => assistantBlocks(row.message?.content));
		const message = open.entry.message;
		message.content = content;
		message.usage = usage(last.message?.usage);
		if (last.isApiErrorMessage) {
			message.stopReason = "error";
			message.errorMessage = content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || String(last.error ?? "API error");
		} else {
			const rawStop = last.message?.stop_reason;
			message.stopReason = (typeof rawStop === "string" && STOP_REASONS[rawStop]) || (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
		}
		for (const block of content) if (block.type === "toolCall") unanswered.set(block.id, last);
		open = undefined;
		for (const item of heldResults) emitResult(item);
		heldResults = [];
		flushPrompts();
	};

	// Give every tool call that never got a result a synthetic error result.
	const answerPending = () => {
		for (const [callId, row] of unanswered) {
			push({
				type: "message",
				id: entryId(`${callId}:missing-result`),
				timestamp: isoTimestamp(row),
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: callNames.get(callId) ?? "unknown",
					content: [{ type: "text", text: "(No result was recorded in the Claude Code transcript.)" }],
					isError: true,
					timestamp: msTimestamp(row),
				},
			});
		}
		unanswered.clear();
	};

	const settle = () => {
		closeAssistant();
		answerPending();
		flushPrompts();
	};

	for (const row of path) {
		if (row.type === "system" && row.subtype === "compact_boundary") {
			lastBoundary = row;
			continue;
		}

		if (row.type === "assistant") {
			const messageId = String(row.message?.id ?? row.uuid);
			for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
				if (block?.type === "tool_use") callNames.set(String(block.id), mapToolCall(String(block.name), block.input).name);
			}
			if (open && open.messageId === messageId) {
				open.rows.push(row);
				idForUuid.set(row.uuid, open.entry.id);
				continue;
			}
			settle();
			const rowModel = typeof row.message?.model === "string" && row.message.model !== "<synthetic>" ? row.message.model : undefined;
			if (rowModel && rowModel !== model) {
				model = rowModel;
				push({ type: "model_change", id: entryId(`${row.uuid}:model`), timestamp: isoTimestamp(row), provider: "anthropic", modelId: model });
			}
			const effort = typeof row.effort === "string" && PI_THINKING_LEVELS.has(row.effort) ? row.effort : undefined;
			if (effort && effort !== thinkingLevel) {
				thinkingLevel = effort;
				push({ type: "thinking_level_change", id: entryId(`${row.uuid}:thinking`), timestamp: isoTimestamp(row), thinkingLevel });
			}
			const entry = push({
				type: "message",
				id: entryId(row.uuid),
				timestamp: isoTimestamp(row),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: rowModel ?? model ?? "claude",
					...(effort ? { thinkingLevel: effort } : {}),
					usage: usage(undefined),
					stopReason: "stop",
					timestamp: msTimestamp(row),
				},
			}, row.uuid);
			open = { messageId, entry, rows: [row] };
			continue;
		}

		if (row.type === "user" && row.isCompactSummary) {
			settle();
			const id = entryId(`${row.uuid}:compaction`);
			const preserved: string[] = lastBoundary?.compactMetadata?.preservedMessages?.uuids ?? [];
			const firstKept = preserved.map((uuid) => idForUuid.get(uuid)).find(Boolean);
			push({
				type: "compaction",
				id,
				timestamp: isoTimestamp(row),
				summary: typeof row.message?.content === "string" ? row.message.content : userText(row.message?.content),
				firstKeptEntryId: firstKept ?? id,
				tokensBefore: Number(lastBoundary?.compactMetadata?.preTokens) || 0,
			}, row.uuid);
			continue;
		}

		if (row.type === "user" && !row.isMeta) {
			const content = row.message?.content;
			const results = Array.isArray(content) ? content.filter((block: any) => block?.type === "tool_result") : [];
			if (results.length > 0) {
				results.forEach((block: any, index: number) => {
					const callId = String(block.tool_use_id);
					const toolName = callNames.get(callId);
					// A result for a call outside the active branch has no call to answer.
					if (!toolName) return;
					const item = {
						uuid: row.uuid,
						entry: {
							type: "message",
							id: entryId(index === 0 ? row.uuid : `${row.uuid}:${index}`),
							timestamp: isoTimestamp(row),
							message: {
								role: "toolResult",
								toolCallId: callId,
								toolName,
								content: toolResultContent(block.content),
								isError: block.is_error === true,
								timestamp: msTimestamp(row),
							},
						},
					};
					if (open) heldResults.push(item);
					else if (unanswered.has(callId)) emitResult(item);
				});
				flushPrompts();
				continue;
			}
			const mapped = userContent(content);
			if (typeof mapped === "string" ? !mapped.trim() : mapped.length === 0) continue;
			settle();
			push({
				type: "message",
				id: entryId(row.uuid),
				timestamp: isoTimestamp(row),
				message: { role: "user", content: mapped, timestamp: msTimestamp(row) },
			}, row.uuid);
			continue;
		}

		if (row.type === "attachment" && row.attachment?.type === "queued_command" && typeof row.attachment.prompt === "string") {
			if (row.attachment.commandMode && row.attachment.commandMode !== "prompt") continue;
			heldPrompts.push({
				uuid: row.uuid,
				entry: {
					type: "message",
					id: entryId(row.uuid),
					timestamp: isoTimestamp(row),
					message: { role: "user", content: row.attachment.prompt, timestamp: msTimestamp(row) },
				},
			});
			flushPrompts();
		}
	}
	settle();

	const title = titleFrom(rows);
	if (title) {
		push({ type: "session_info", id: entryId(`${sessionId}:title:${title}`), timestamp: isoTimestamp(path[path.length - 1]!), name: `[Claude] ${title}` });
	}

	return {
		header: { type: "session", version: 3, id: sessionId, timestamp: isoTimestamp(first), cwd: String(first.cwd ?? "") },
		entries,
		title,
	};
}

function userText(content: unknown): string {
	if (!Array.isArray(content)) return String(content ?? "");
	return content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n");
}
