/** No single bash call or background wait blocks the agent longer than this. */
export const MAX_BLOCKING_SECONDS = 8 * 60;

export const BACKGROUND_PROCESS_PROMPT = `Use bash_bg_start for non-interactive bash commands such as servers, watchers, long builds, and long tests that can run independently. Use regular bash for commands whose result is needed immediately; if one runs longer than expected, it is moved to the background instead of being killed.

After bash_bg_start, continue useful work instead of polling. Use bash_bg_wait only when further progress truly depends on completion. A wait never blocks longer than ${MAX_BLOCKING_SECONDS / 60} minutes; a timed-out or interrupted wait leaves the process running. Finished background processes are reported to you automatically, waking you if you are idle. Stop processes that are no longer needed and avoid duplicate servers or watchers.

A bash command launched with bash_bg_start must stay in the foreground from its shell's perspective. Do not append &, use start, Start-Process, nohup, daemon flags, or any other nested backgrounding mechanism. bash_bg_start itself supplies the background lifetime.

Background bash commands receive no stdin. Never use prompts, password requests, menus, REPLs, editors, or other interactive programs.`;

export const BASH_TIMEOUT_DESCRIPTION = `Timeout in seconds. Defaults to and is capped at ${MAX_BLOCKING_SECONDS} (${MAX_BLOCKING_SECONDS / 60} minutes). A command still running at the timeout is moved to the background, not killed.`;

export function bashToolDescription(builtinDescription: string): string {
	return `${builtinDescription.replace(/\s*Optionally provide a timeout in seconds\.\s*$/u, "")}

The timeout defaults to and is capped at ${MAX_BLOCKING_SECONDS} seconds. A command that is still running when the timeout elapses, or when the user sends a message, is NOT killed: it is moved to the background with an ID (bg-N) usable with bash_bg_wait, bash_bg_status, and bash_bg_kill, and its completion is reported to you automatically. For servers, watchers, and other work known to be long-running, prefer bash_bg_start.`;
}

export type BackgroundNoticeCause =
	| { kind: "bash-timeout"; id: string; seconds: number }
	| { kind: "bash-steer"; id: string }
	| { kind: "wait-timeout"; ids: string[]; seconds: number }
	| { kind: "wait-steer"; ids: string[] };

/** Marks where model-facing guidance starts so renderers can leave it out of the transcript. */
export const BACKGROUND_NOTICE_MARKER = "[Background process notice]";

/** Static guidance appended to every result that leaves a process running without a final result. */
export function backgroundNotice(cause: BackgroundNoticeCause): string {
	const ids = "id" in cause ? [cause.id] : cause.ids;
	const list = ids.join(", ");
	const idsJson = JSON.stringify(ids);
	const subject = ids.length === 1 ? `${list} is` : `${list} are`;
	const lines = [BACKGROUND_NOTICE_MARKER];
	switch (cause.kind) {
		case "bash-timeout":
			lines.push(`The command did not finish within ${cause.seconds}s, so it was moved to the background as ${cause.id}. It was NOT killed and is still running.`);
			break;
		case "bash-steer":
			lines.push(`The user sent a message while the command was running, so it was moved to the background as ${cause.id}. It was NOT killed and is still running. Read and address the user's message first.`);
			break;
		case "wait-timeout":
			lines.push(`The wait timed out after ${cause.seconds}s. ${subject} still running; nothing was killed.`);
			break;
		case "wait-steer":
			lines.push(`The user sent a message, which interrupted the wait. ${subject} still running; nothing was killed. Read and address the user's message first.`);
			break;
	}
	lines.push(
		`- If your next step depends on the result, call bash_bg_wait with ids ${idsJson} (it waits at most ${MAX_BLOCKING_SECONDS / 60} minutes per call).`,
		"- Otherwise, continue with other useful work, or simply end your turn: when the process finishes, its result is delivered to you automatically and you are woken up.",
		"- If it is no longer needed or appears stuck, stop it with bash_bg_kill.",
	);
	return lines.join("\n");
}

export function withBackgroundNotice(text: string, cause: BackgroundNoticeCause): string {
	return `${text ? `${text.trimEnd()}\n\n` : ""}${backgroundNotice(cause)}`;
}

/** The part of a result text written before any background notice. */
export function stripBackgroundNotice(text: string): string {
	const index = text.indexOf(BACKGROUND_NOTICE_MARKER);
	return index === -1 ? text : text.slice(0, index).trimEnd();
}

export function normalizeTitle(title: string): string {
	const normalized = title.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
	return [...normalized].slice(0, 80).join("");
}

/** A readable title for a command that was moved to the background without one. */
export function titleFromCommand(command: string): string {
	const firstLine = command.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? command;
	const characters = [...firstLine.replace(/\s+/gu, " ")];
	return characters.length <= 80 ? characters.join("") : `${characters.slice(0, 79).join("")}…`;
}
