import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectGitSnapshot } from "./git-status-widget/git.ts";

const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;
const GRAY = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function isStaleContextError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("This extension ctx is stale")
  );
}

type WidgetState = {
  active: boolean;
  interval: NodeJS.Timeout | undefined;
  updateInFlight: boolean;
  generation: number;
  abortController: AbortController | undefined;
  widgetInitialized: boolean;
  lastWidgetSignature: string | null;
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

  const signature = lines === undefined ? null : JSON.stringify(lines);
  if (state.widgetInitialized && state.lastWidgetSignature === signature) return;

  try {
    ctx.ui.setWidget(WIDGET_ID, lines);
    state.widgetInitialized = true;
    state.lastWidgetSignature = signature;
  } catch (error) {
    if (!isStaleContextError(error)) console.error(error);
  }
}

async function refreshWidget(
  ctx: ExtensionContext,
  state: WidgetState,
  generation: number,
  signal: AbortSignal,
) {
  if (!state.active || state.generation !== generation) return;

  let cwd: string;
  try {
    if (!ctx.hasUI) return;
    cwd = ctx.cwd;
  } catch (error) {
    if (!isStaleContextError(error)) console.error(error);
    return;
  }

  try {
    const snapshot = await collectGitSnapshot(cwd, { signal });

    if (!state.active || state.generation !== generation) return;

    const fileLabel = snapshot.unstagedCount === 1 ? "file" : "files";
    const addedPrefix = snapshot.lineStatsComplete ? "+" : "~+";
    const addedText = `${snapshot.added > 0 ? GREEN : GRAY}${addedPrefix}${snapshot.added}`;
    const removedText = `${snapshot.removed > 0 ? RED : GRAY}-${snapshot.removed}`;
    const text = `${GRAY} ${snapshot.branch} · ${snapshot.unstagedCount} unstaged ${fileLabel} · ${addedText}${GRAY} ${removedText}${RESET}`;
    setWidget(ctx, state, [text]);
  } catch {
    // Keep the last successful status visible while Git is slow or temporarily unavailable.
  }
}

function updateWidget(ctx: ExtensionContext, state: WidgetState) {
  if (!state.active || state.updateInFlight) return;

  const generation = state.generation;
  const controller = state.abortController;
  if (!controller || controller.signal.aborted) return;
  state.updateInFlight = true;
  void refreshWidget(ctx, state, generation, controller.signal)
    .catch((error) => {
      if (!isStaleContextError(error)) console.error(error);
    })
    .finally(() => {
      if (state.generation === generation) state.updateInFlight = false;
    });
}

export default function (pi: ExtensionAPI) {
  const state: WidgetState = {
    active: true,
    interval: undefined,
    updateInFlight: false,
    generation: 0,
    abortController: undefined,
    widgetInitialized: false,
    lastWidgetSignature: null,
  };

  pi.on("session_start", (_event, ctx) => {
    state.abortController?.abort();
    state.active = true;
    state.generation += 1;
    state.abortController = new AbortController();
    state.updateInFlight = false;
    state.widgetInitialized = false;
    state.lastWidgetSignature = null;
    if (state.interval) clearInterval(state.interval);

    updateWidget(ctx, state);
    state.interval = setInterval(() => {
      updateWidget(ctx, state);
    }, UPDATE_INTERVAL_MS);
  });

  pi.on("input", (_event, ctx) => {
    updateWidget(ctx, state);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    updateWidget(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.active = false;
    state.generation += 1;
    state.abortController?.abort();
    state.abortController = undefined;
    state.updateInFlight = false;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    clearWidget(ctx);
  });
}
