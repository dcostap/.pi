import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-peak-status";
const UPDATE_INTERVAL_MS = 60_000;
const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

// DeepSeek official V4 peak windows, in UTC. End is exclusive.
const PEAK_WINDOWS_UTC = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
] as const;

type PeakState = {
  isPeak: boolean;
  nextTransition: Date;
  hoursUntil: number;
};

function isOfficialDeepSeekV4(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return model?.provider === DEEPSEEK_PROVIDER && DEEPSEEK_V4_MODELS.has(model.id);
}

function utcDateAt(date: Date, hour: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour,
    0,
    0,
    0,
  ));
}

function getPeakState(now = new Date()): PeakState {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const isPeak = PEAK_WINDOWS_UTC.some(
    ({ startHour, endHour }) => utcHour >= startHour && utcHour < endHour,
  );

  const candidates: Date[] = [];
  for (const dayOffset of [0, 1]) {
    const base = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
      0,
      0,
      0,
      0,
    ));

    for (const { startHour, endHour } of PEAK_WINDOWS_UTC) {
      candidates.push(utcDateAt(base, startHour), utcDateAt(base, endHour));
    }
  }

  const nextTransition = candidates
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const hoursUntil = nextTransition
    ? Math.max(0, Math.round(((nextTransition.getTime() - now.getTime()) / 3_600_000) * 10) / 10)
    : 0;

  return { isPeak, nextTransition, hoursUntil };
}

function formatTransition(date?: Date): string {
  if (!date) return "??:?? local";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} local`;
}

function safeSetStatus(ctx: ExtensionContext, value: string | undefined): void {
  try {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, value);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("This extension ctx is stale")) {
      console.error(error);
    }
  }
}

function formatHoursLeft(hoursUntil: number): string {
  if (hoursUntil < 1) return "<1 hour";

  const rounded = Math.round(hoursUntil * 10) / 10;
  return rounded === 1 ? "1 hour" : `${rounded} hours`;
}

function renderStatus(ctx: ExtensionContext, state: PeakState): string {
  const theme = ctx.ui.theme;
  const until = formatTransition(state.nextTransition);
  const remaining = formatHoursLeft(state.hoursUntil);

  if (state.isPeak) {
    return [
      theme.fg("muted", "DeepSeek API: "),
      theme.fg("warning", `peak pricing (2×) until ${until}`),
      theme.fg("dim", ` (${remaining} left)`),
    ].join("");
  }

  return [
    theme.fg("muted", "DeepSeek API: "),
    theme.fg("success", `off-peak until ${until}`),
    theme.fg("dim", ` (${remaining} left)`),
  ].join("");
}

function updateStatus(ctx: ExtensionContext): void {
  if (!isOfficialDeepSeekV4(ctx)) {
    safeSetStatus(ctx, undefined);
    return;
  }

  safeSetStatus(ctx, renderStatus(ctx, getPeakState()));
}

export default function (pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;

  function startTimer(ctx: ExtensionContext): void {
    if (interval) clearInterval(interval);
    updateStatus(ctx);
    interval = setInterval(() => updateStatus(ctx), UPDATE_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    startTimer(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    safeSetStatus(ctx, undefined);
  });

  pi.registerCommand("deepseek-peak", {
    description: "Show DeepSeek official V4 peak/off-peak pricing window status",
    handler: async (_args, ctx) => {
      const state = getPeakState();
      const until = formatTransition(state.nextTransition);
      const remaining = formatHoursLeft(state.hoursUntil);
      const status = state.isPeak ? "peak hours (2× price)" : "off-peak hours";
      const schedule = "Peak UTC: 01:00–04:00 and 06:00–10:00";
      ctx.ui.notify(
        `DeepSeek API is currently in ${status}. Next change: ${until} (${remaining} left). ${schedule}.`,
        state.isPeak ? "warning" : "info",
      );
      updateStatus(ctx);
    },
  });
}
