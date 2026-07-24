import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type LoadedPrompt = {
	name: string;
	description?: string;
	argumentHint?: string;
	content: string;
};

type SlashContext = {
	prefix: string;
	isMessageStart: boolean;
};

const SLASH_TOKEN = /(?:^|[ \t])(\/[a-zA-Z0-9._:-]*)$/;
const PLACEHOLDER = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

function unquoteYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function parsePromptFile(filePath: string): { content: string; argumentHint?: string } | null {
	try {
		const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
		const lines = raw.split(/\r?\n/);
		if (lines[0]?.trim() !== "---") {
			return { content: raw.trim() };
		}

		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (end === -1) {
			return { content: raw.trim() };
		}

		let argumentHint: string | undefined;
		for (const line of lines.slice(1, end)) {
			const match = line.match(/^argument-hint\s*:\s*(.*)$/i);
			if (match) {
				argumentHint = unquoteYamlScalar(match[1] ?? "") || undefined;
				break;
			}
		}

		return {
			content: lines.slice(end + 1).join("\n").trim(),
			...(argumentHint && { argumentHint }),
		};
	} catch {
		return null;
	}
}

function getHintPlaceholders(argumentHint: string | undefined): string[] {
	if (!argumentHint) return [];
	const hints = argumentHint.match(/<[^>]+>|\[[^\]]+\]/g) ?? [argumentHint];
	return hints.map((hint) => {
		const optional = hint.startsWith("[") && hint.endsWith("]");
		const unwrapped = /^[<[].*[>\]]$/.test(hint) ? hint.slice(1, -1) : hint;
		const label = unwrapped
			.trim()
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "ARGUMENT";
		return `{{${label}${optional ? "?" : ""}}}`;
	});
}

function materializePlaceholders(content: string, argumentHint: string | undefined): string {
	const hints = getHintPlaceholders(argumentHint);
	const positional = (index: number): string => hints[index - 1] ?? `{{ARG_${index}}}`;
	const allArguments = (): string => (hints.length > 0 ? hints.join(" ") : "{{ARGUMENTS}}");
	const withDefault = (placeholder: string, defaultValue: string): string => {
		if (!defaultValue) return placeholder;
		if (placeholder.startsWith("{{") && placeholder.endsWith("}}") && !placeholder.includes(" ")) {
			return `{{${placeholder.slice(2, -2)}|default:${defaultValue}}}`;
		}
		return `{{ARGUMENTS|default:${defaultValue}}}`;
	};

	return content.replace(
		PLACEHOLDER,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const placeholder = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
					? allArguments()
					: positional(Number.parseInt(defaultTarget, 10));
				return withDefault(placeholder, defaultValue);
			}

			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				const length = sliceLength ? Number.parseInt(sliceLength, 10) : undefined;
				const sliced = length === undefined ? hints.slice(start) : hints.slice(start, start + length);
				return sliced.length > 0 ? sliced.join(" ") : `{{ARGUMENTS_FROM_${start + 1}}}`;
			}

			if (simple === "ARGUMENTS" || simple === "@") return allArguments();
			return positional(Number.parseInt(simple, 10));
		},
	);
}

function getSlashContext(lines: string[], cursorLine: number, cursorCol: number): SlashContext | null {
	const currentLine = lines[cursorLine] ?? "";
	const beforeCursor = currentLine.slice(0, cursorCol);
	const match = beforeCursor.match(SLASH_TOKEN);
	if (!match) return null;

	const prefix = match[1] ?? "";
	const tokenStart = cursorCol - prefix.length;
	return {
		prefix,
		isMessageStart: cursorLine === 0 && beforeCursor.slice(0, tokenStart).trim() === "",
	};
}

function insertPrompt(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	prefix: string,
	content: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
	const afterCursor = currentLine.slice(cursorCol);
	const insertedLines = content.split("\n");

	if (insertedLines.length === 1) {
		const inserted = insertedLines[0] ?? "";
		const nextLines = [...lines];
		nextLines[cursorLine] = beforePrefix + inserted + afterCursor;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: beforePrefix.length + inserted.length,
		};
	}

	const first = insertedLines[0] ?? "";
	const last = insertedLines[insertedLines.length - 1] ?? "";
	const replacement = [beforePrefix + first, ...insertedLines.slice(1, -1), last + afterCursor];
	const nextLines = [...lines];
	nextLines.splice(cursorLine, 1, ...replacement);
	return {
		lines: nextLines,
		cursorLine: cursorLine + insertedLines.length - 1,
		cursorCol: last.length,
	};
}

function createPromptProvider(current: AutocompleteProvider, prompts: Map<string, LoadedPrompt>): AutocompleteProvider {
	const items = [...prompts.values()].map((prompt) => ({
		value: prompt.name,
		label: prompt.name,
		...(prompt.description && { description: prompt.description }),
	}));

	return {
		triggerCharacters: current.triggerCharacters,

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const context = getSlashContext(lines, cursorLine, cursorCol);
			if (!context || context.isMessageStart) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = context.prefix.slice(1);
			const filtered = fuzzyFilter(items, query, (item) => item.value);
			if (filtered.length === 0) return null;
			return { items: filtered, prefix: context.prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem, prefix) {
			const prompt = prefix.startsWith("/") ? prompts.get(item.value) : undefined;
			if (!prompt) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return insertPrompt(
				lines,
				cursorLine,
				cursorCol,
				prefix,
				materializePlaceholders(prompt.content, prompt.argumentHint),
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (getSlashContext(lines, cursorLine, cursorCol)) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const prompts = new Map<string, LoadedPrompt>();
		for (const command of pi.getCommands()) {
			if (command.source !== "prompt") continue;
			const parsed = parsePromptFile(command.sourceInfo.path);
			if (!parsed) continue;
			prompts.set(command.name, {
				name: command.name,
				description: command.description,
				content: parsed.content,
				...(parsed.argumentHint && { argumentHint: parsed.argumentHint }),
			});
		}

		if (prompts.size > 0) {
			ctx.ui.addAutocompleteProvider((current) => createPromptProvider(current, prompts));
		}
	});
}
