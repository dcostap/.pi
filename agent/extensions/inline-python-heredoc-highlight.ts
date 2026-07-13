/**
 * Live syntax highlighting for Python embedded in bash heredocs.
 *
 * The bash call renderer is updated as tool arguments stream. As soon as a
 * complete Python heredoc opener is present, the unfinished body is rendered
 * as Python; it does not wait for the closing delimiter.
 */
import {
	createBashToolDefinition,
	highlightCode,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type HighlightLanguage = "bash" | "python" | undefined;

interface HighlightLine {
	text: string;
	language: HighlightLanguage;
}

interface Heredoc {
	delimiter: string;
	stripLeadingTabs: boolean;
	python: boolean;
}

interface ShellWord {
	value: string;
	end: number;
}

const PYTHON_EXECUTABLE = /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(command: string): string {
	return command.replace(/\\/g, "/").split("/").pop() ?? command;
}

function isPythonExecutable(command: string): boolean {
	return PYTHON_EXECUTABLE.test(basename(command));
}

/** Return shell words with quoting removed. This only needs to identify the
 * command before a heredoc, not perform shell expansion. */
function shellWords(text: string): ShellWord[] {
	const words: ShellWord[] = [];
	let value = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;

	const finish = (end: number) => {
		if (!inWord) return;
		words.push({ value, end });
		value = "";
		inWord = false;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && quote === '"' && i + 1 < text.length) {
				value += text[++i]!;
			} else {
				value += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && i + 1 < text.length) {
			inWord = true;
			value += text[++i]!;
		} else if (/\s/.test(char)) {
			finish(i);
		} else {
			inWord = true;
			value += char;
		}
	}
	finish(text.length);
	return words;
}

function skipOptions(words: ShellWord[], start: number): number {
	let index = start;
	while (index < words.length && words[index]!.value.startsWith("-")) index++;
	return index;
}

/** Determine whether a command segment launches Python. Common wrappers are
 * supported, while ordinary arguments containing the word "python" are not. */
function segmentRunsPython(segment: string): boolean {
	const words = shellWords(segment);
	let index = 0;
	while (index < words.length && ASSIGNMENT.test(words[index]!.value)) index++;
	if (index >= words.length) return false;

	let executable = basename(words[index]!.value).toLowerCase();
	if (isPythonExecutable(executable)) return true;

	// Shell command wrappers that are commonly placed before an executable.
	while (["command", "builtin", "exec", "nohup"].includes(executable)) {
		index = skipOptions(words, index + 1);
		if (index >= words.length) return false;
		executable = basename(words[index]!.value).toLowerCase();
		if (isPythonExecutable(executable)) return true;
	}

	if (executable === "env") {
		index++;
		while (
			index < words.length &&
			(words[index]!.value.startsWith("-") || ASSIGNMENT.test(words[index]!.value))
		) {
			index++;
		}
		return index < words.length && isPythonExecutable(words[index]!.value);
	}

	// uv/poetry/pipenv can all launch `python` through their `run` command.
	if (["uv", "poetry", "pipenv"].includes(executable)) {
		const runIndex = words.findIndex((word, i) => i > index && word.value === "run");
		return runIndex >= 0 && words.slice(runIndex + 1).some((word) => isPythonExecutable(word.value));
	}

	return false;
}

/** Find where the current command segment starts, ignoring control characters
 * inside quotes. */
function commandSegmentStart(line: string, end: number): number {
	let start = 0;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < end; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "\\") i++;
		else if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") start = i + 1;
	}
	return start;
}

/** Parse one heredoc delimiter, including quoted and backslash-escaped words. */
function parseDelimiter(line: string, start: number): { delimiter: string; end: number } | undefined {
	let index = start;
	let delimiter = "";
	let consumed = false;

	while (index < line.length) {
		const char = line[index]!;
		if (/\s/.test(char) || ";|&<>()".includes(char)) break;
		consumed = true;

		if (char === "'" || char === '"') {
			const quote = char;
			index++;
			while (index < line.length && line[index] !== quote) {
				if (line[index] === "\\" && quote === '"' && index + 1 < line.length) {
					delimiter += line[index + 1]!;
					index += 2;
				} else {
					delimiter += line[index++]!;
				}
			}
			// A quoted delimiter is not complete until its closing quote has
			// streamed in. Waiting here prevents a temporary, wrong delimiter.
			if (line[index] !== quote) return undefined;
			index++;
		} else if (char === "\\" && index + 1 < line.length) {
			delimiter += line[index + 1]!;
			index += 2;
		} else {
			delimiter += char;
			index++;
		}
	}

	return consumed && delimiter ? { delimiter, end: index } : undefined;
}

/** Locate unquoted heredoc operators on a shell command line. */
function findHeredocs(line: string): Heredoc[] {
	const heredocs: Heredoc[] = [];
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\") {
			i++;
			continue;
		}
		// An unquoted # at the start of a shell word comments out the rest.
		if (char === "#" && (i === 0 || /\s|[;&|()]/.test(line[i - 1]!))) break;
		if (char !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;

		let index = i + 2;
		let stripLeadingTabs = false;
		if (line[index] === "-") {
			stripLeadingTabs = true;
			index++;
		}
		while (line[index] === " " || line[index] === "\t") index++;
		const parsed = parseDelimiter(line, index);
		if (!parsed) continue; // The delimiter may still be streaming.

		const segmentStart = commandSegmentStart(line, i);
		heredocs.push({
			delimiter: parsed.delimiter,
			stripLeadingTabs,
			python: segmentRunsPython(line.slice(segmentStart, i)),
		});
		i = parsed.end - 1;
	}

	return heredocs;
}

function classifyLines(command: string): HighlightLine[] {
	const lines = command.split("\n");
	const result: HighlightLine[] = [];
	const pending: Heredoc[] = [];
	let active: Heredoc | undefined;

	for (const text of lines) {
		if (active) {
			const candidate = active.stripLeadingTabs ? text.replace(/^\t+/, "") : text;
			if (candidate.replace(/\r$/, "") === active.delimiter) {
				result.push({ text, language: "bash" });
				active = pending.shift();
			} else {
				result.push({ text, language: active.python ? "python" : undefined });
			}
			continue;
		}

		result.push({ text, language: "bash" });
		pending.push(...findHeredocs(text));
		active = pending.shift();
	}

	return result;
}

function highlightMixedCommand(command: string): string {
	const lines = classifyLines(command);
	const output: string[] = [];

	for (let start = 0; start < lines.length; ) {
		const language = lines[start]!.language;
		let end = start + 1;
		while (end < lines.length && lines[end]!.language === language) end++;
		const source = lines.slice(start, end).map((line) => line.text).join("\n");
		output.push(highlightCode(source, language).join("\n"));
		start = end;
	}

	return output.join("\n");
}

export default function inlinePythonHeredocHighlight(pi: ExtensionAPI) {
	const bash = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...bash,
		renderCall(args, theme, context) {
			// Preserve the timing state used by the inherited bash result renderer.
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const command = typeof args?.command === "string" ? args.command : "";
			const commandDisplay = command
				? highlightMixedCommand(command)
				: theme.fg("toolOutput", "...");
			const timeout = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			component.setText(theme.fg("toolTitle", theme.bold("$ ")) + commandDisplay + timeout);
			return component;
		},
	});
}
