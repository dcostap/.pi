import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;
const GRAY = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function getBranch(cwd: string) {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (branch.length > 0) return branch;

  const head = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return head.length > 0 ? `detached@${head}` : "unknown";
}

function getUntrackedFiles(statusOutput: string) {
  if (statusOutput.length === 0) return [];

  const files: string[] = [];
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("?? ")) files.push(line.slice(3));
  }
  return files;
}

function countUnstagedFiles(statusOutput: string) {
  if (statusOutput.length === 0) return 0;

  let count = 0;
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??") || line[1] !== " ") count += 1;
  }
  return count;
}

async function getStatus(cwd: string) {
  return runGit(["status", "--porcelain", "--untracked-files=normal"], cwd);
}

async function countTextFileLines(path: string) {
  const buffer = await readFile(path);
  if (buffer.includes(0)) return 0;
  if (buffer.length === 0) return 0;

  let lines = 0;
  for (const byte of buffer) {
    if (byte === 10) lines += 1;
  }
  if (buffer[buffer.length - 1] !== 10) lines += 1;
  return lines;
}

async function getUntrackedLineStats(cwd: string, statusOutput: string) {
  const files = getUntrackedFiles(statusOutput);
  const counts = await Promise.all(
    files.map(async (file) => {
      try {
        return await countTextFileLines(join(cwd, file));
      } catch {
        return 0;
      }
    }),
  );
  return { added: counts.reduce((sum, count) => sum + count, 0), removed: 0 };
}

function parseNumstat(output: string) {
  let added = 0;
  let removed = 0;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const [additions, deletions] = line.split("\t");
    if (additions && additions !== "-") added += Number(additions) || 0;
    if (deletions && deletions !== "-") removed += Number(deletions) || 0;
  }

  return { added, removed };
}

async function getLineStats(cwd: string, statusOutput: string) {
  const [unstaged, staged, untrackedStats] = await Promise.all([
    runGit(["diff", "--numstat"], cwd),
    runGit(["diff", "--cached", "--numstat"], cwd),
    getUntrackedLineStats(cwd, statusOutput),
  ]);

  const unstagedStats = parseNumstat(unstaged);
  const stagedStats = parseNumstat(staged);

  return {
    added: unstagedStats.added + stagedStats.added + untrackedStats.added,
    removed: unstagedStats.removed + stagedStats.removed + untrackedStats.removed,
  };
}

function isStaleContextError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("This extension ctx is stale")
  );
}

type WidgetState = {
  active: boolean;
  interval: NodeJS.Timeout | undefined;
};

function clearWidget(ctx: ExtensionContext) {
  try {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  } catch (error) {
    if (!isStaleContextError(error)) console.error(error);
  }
}

function setWidget(ctx: ExtensionContext, state: WidgetState, lines: string[] | undefined) {
  if (!state.active) return;

  try {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } catch (error) {
    if (!isStaleContextError(error)) console.error(error);
  }
}

async function updateWidget(ctx: ExtensionContext, state: WidgetState) {
  if (!state.active) return;

  let cwd: string;
  try {
    if (!ctx.hasUI) return;
    cwd = ctx.cwd;
  } catch (error) {
    if (!isStaleContextError(error)) console.error(error);
    return;
  }

  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    const [branch, status] = await Promise.all([
      getBranch(cwd),
      getStatus(cwd),
    ]);
    const [unstagedCount, lineStats] = await Promise.all([
      Promise.resolve(countUnstagedFiles(status)),
      getLineStats(cwd, status),
    ]);

    if (!state.active) return;

    const fileLabel = unstagedCount === 1 ? "file" : "files";
    const addedText = `${lineStats.added > 0 ? GREEN : GRAY}+${lineStats.added}`;
    const removedText = `${lineStats.removed > 0 ? RED : GRAY}-${lineStats.removed}`;
    const text = `${GRAY} ${branch} · ${unstagedCount} unstaged ${fileLabel} · ${addedText}${GRAY} ${removedText}${RESET}`;
    setWidget(ctx, state, [text]);
  } catch {
    setWidget(ctx, state, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  const state: WidgetState = { active: true, interval: undefined };

  pi.on("session_start", async (_event, ctx) => {
    state.active = true;
    if (state.interval) clearInterval(state.interval);

    await updateWidget(ctx, state);
    state.interval = setInterval(() => {
      void updateWidget(ctx, state);
    }, UPDATE_INTERVAL_MS);
  });

  pi.on("input", async (_event, ctx) => {
    await updateWidget(ctx, state);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    await updateWidget(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.active = false;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    clearWidget(ctx);
  });
}
