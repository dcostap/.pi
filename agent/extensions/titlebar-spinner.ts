/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * In Windows Terminal, also emits native OSC 9;4 progress sequences so the tab/taskbar
 * can show the built-in indeterminate progress ring. On completion, it clears progress
 * and emits BEL so Windows Terminal can show its native bell notification (depending on
 * the user's bellStyle settings).
 *
 * In a linked Git worktree, the title starts with "wt:<worktree folder>".
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLinkedWorktree } from "./_shared/git-worktree.ts";
import { runGit } from "./git-status-widget/git.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const OSC = "\x1b]";
const BEL = "\x07";

function buildTitle(pi: ExtensionAPI, activeCwd: string, worktree: string | undefined, status = ""): string {
	const cwd = path.basename(activeCwd);
	const session = pi.getSessionName();
	// The worktree prefix already names the folder, so the title does not repeat it.
	const place = worktree === cwd ? [] : [cwd];
	const title = ["π", ...(session ? [session] : []), ...place].join(" - ");
	return [...(worktree ? [`wt:${worktree}`] : []), ...(status ? [status] : []), title].join(" ");
}

function isWindowsTerminal(): boolean {
	return process.platform === "win32" && !!process.env.WT_SESSION && !!process.stdout?.isTTY;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `[${seconds} s]`;
	const minutes = Math.floor(seconds / 60);
	return `[${minutes} min]`;
}

function writeTerminalSequence(sequence: string): void {
	if (!process.stdout?.isTTY) return;
	try {
		process.stdout.write(sequence);
	} catch {
		// Ignore terminal write failures; title animation remains as fallback.
	}
}

function setWindowsTerminalIndeterminateProgress(): void {
	if (!isWindowsTerminal()) return;
	writeTerminalSequence(`${OSC}9;4;3;0${BEL}`);
}

function clearWindowsTerminalProgress(): void {
	if (!isWindowsTerminal()) return;
	writeTerminalSequence(`${OSC}9;4;0;0${BEL}`);
}

function ringWindowsTerminalBell(): void {
	if (!isWindowsTerminal()) return;
	writeTerminalSequence(BEL);
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let startedAt = 0;
	// Worktree names by directory. A pending lookup reads as no worktree.
	const worktrees = new Map<string, string | undefined>();

	function worktreeFor(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		if (worktrees.has(cwd)) return worktrees.get(cwd);
		worktrees.set(cwd, undefined);
		void getLinkedWorktree(cwd, runGit).then((worktree) => {
			worktrees.set(cwd, worktree);
			// A running animation picks up the name on its next frame.
			if (!worktree || timer || ctx.cwd !== cwd) return;
			try {
				ctx.ui.setTitle(buildTitle(pi, cwd, worktree));
			} catch {
				// Session replacement can stale a context before the lookup ends.
			}
		});
		return undefined;
	}

	function stopAnimation(ctx: ExtensionContext, notifyDone = false) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		startedAt = 0;
		ctx.ui.setTitle(buildTitle(pi, ctx.cwd, worktreeFor(ctx)));
		clearWindowsTerminalProgress();
		if (notifyDone) ringWindowsTerminalBell();
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		startedAt = Date.now();
		setWindowsTerminalIndeterminateProgress();
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const elapsed = formatElapsed(Date.now() - startedAt);
			ctx.ui.setTitle(buildTitle(pi, ctx.cwd, worktreeFor(ctx), `${frame} ${elapsed}`));
			frameIndex++;
		}, 80);
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setTitle(buildTitle(pi, ctx.cwd, worktreeFor(ctx)));
	});

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
