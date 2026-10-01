import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let totalStartMs = 0;
  let requestMs = 0;
  let timedAssistantMessages = 0;
  let requestTimingValid = true;
  let providerRequestCount = 0;
  let pendingProviderLatencyStartMs = 0;
  const providerLatenciesMs: number[] = [];
  let lastStats: string | undefined;
  let lastStatsAtMs = 0;
  let reshowStatsAfterCompaction = false;
  const activeToolStarts = new Map<string, number>();
  const toolIntervals: Array<[number, number]> = [];

  function reset() {
    totalStartMs = 0;
    requestMs = 0;
    timedAssistantMessages = 0;
    requestTimingValid = true;
    providerRequestCount = 0;
    pendingProviderLatencyStartMs = 0;
    providerLatenciesMs.length = 0;
    activeToolStarts.clear();
    toolIntervals.length = 0;
  }

  function formatDuration(ms: number) {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
  }

  function currentToolMs() {
    const now = Date.now();
    const intervals = [
      ...toolIntervals,
      ...Array.from(activeToolStarts.values(), (start) => [start, now] as [number, number]),
    ].sort((a, b) => a[0] - b[0]);

    let total = 0;
    let currentStart: number | undefined;
    let currentEnd: number | undefined;

    for (const [start, end] of intervals) {
      if (currentStart === undefined || currentEnd === undefined) {
        currentStart = start;
        currentEnd = end;
      } else if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end);
      } else {
        total += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      }
    }

    if (currentStart !== undefined && currentEnd !== undefined) {
      total += currentEnd - currentStart;
    }

    return Math.max(0, total);
  }

  function estimateOutputTokens(content: unknown) {
    if (!Array.isArray(content)) return 0;
    let characters = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") characters += block.text.length;
      if (block.type === "thinking" && typeof block.thinking === "string") characters += block.thinking.length;
      if (block.type === "toolCall") {
        if (typeof block.name === "string") characters += block.name.length;
        characters += (JSON.stringify(block.arguments ?? {}) ?? "").length;
      }
    }
    // Round once per message, not once per streamed chunk.
    return Math.ceil(characters / 4);
  }

  function formatTokens(tokens: number) {
    if (tokens < 1000) return `${Math.round(tokens)}`;
    return `${(tokens / 1000).toFixed(1)}k`;
  }

  function tokensPerSecond(usage: TurnTokenUsage): number | null {
    if (!requestTimingValid || timedAssistantMessages !== usage.assistantMessages || requestMs < 100) return null;
    if (usage.output <= 0) return null;
    const rate = usage.output * 1000 / requestMs;
    return Number.isFinite(rate) ? rate : null;
  }

  function formatTokenRate(rate: number, estimated: boolean) {
    const prefix = estimated ? "~" : "";
    return `${prefix}${rate.toFixed(1)} tok/s`;
  }

  function formatClock(date = new Date()) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes} `;
  }

  function fitsLine(text: string, maxWidth: number | undefined) {
    return maxWidth === undefined || visibleWidth(text) <= maxWidth;
  }

  function terminalWidth() {
    return typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : undefined;
  }

  function average(values: number[]) {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  interface TurnTokenUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    exact: boolean;
    assistantMessages: number;
  }

  function validCount(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function turnTokenUsage(messages: unknown[]): TurnTokenUsage {
    const usage: TurnTokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      exact: true,
      assistantMessages: 0,
    };

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const maybeMessage = message as {
        role?: unknown;
        content?: unknown;
        usage?: {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
        };
      };
      if (maybeMessage.role !== "assistant") continue;
      usage.assistantMessages++;

      const messageUsage = maybeMessage.usage;
      if (messageUsage && validCount(messageUsage.input)) usage.input += messageUsage.input;
      if (messageUsage && validCount(messageUsage.cacheRead)) usage.cacheRead += messageUsage.cacheRead;
      if (messageUsage && validCount(messageUsage.cacheWrite)) usage.cacheWrite += messageUsage.cacheWrite;
      if (messageUsage && validCount(messageUsage.output)) {
        usage.output += messageUsage.output;
      } else {
        usage.output += estimateOutputTokens(maybeMessage.content);
        usage.exact = false;
      }
    }

    return usage;
  }

  function formatUsage(usage: TurnTokenUsage) {
    const parts: string[] = [];
    if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
    return parts.join(" ");
  }

  function formatStats(
    usage: TurnTokenUsage,
    rate: number | null,
    finishedAt = new Date(),
  ) {
    const totalMs = totalStartMs > 0 ? Date.now() - totalStartMs : 0;
    const toolMs = currentToolMs();
    const usagePart = formatUsage(usage);
    const avgLatencyMs = average(providerLatenciesMs);
    const maxWidth = terminalWidth();

    const totalPart = `${formatDuration(totalMs)} total`;
    const toolPart = `${formatDuration(toolMs)} tools`;
    const latencyPart = avgLatencyMs > 0 ? `${formatDuration(avgLatencyMs)} avg latency` : undefined;
    const usageRatePart = [usagePart, rate === null ? undefined : formatTokenRate(rate, !usage.exact)]
      .filter(Boolean).join(" · ") || undefined;
    const clockPart = formatClock(finishedAt);

    const candidates = [
      [totalPart, toolPart, latencyPart, usageRatePart, clockPart],
      [totalPart, latencyPart, usageRatePart, clockPart],
      [totalPart, usageRatePart, clockPart],
      [totalPart, usagePart || undefined, clockPart],
      [totalPart, clockPart],
      [clockPart],
    ];

    for (const candidate of candidates) {
      const line = candidate.filter(Boolean).join(" · ");
      if (fitsLine(line, maxWidth)) return line;
    }

    return clockPart;
  }

  pi.on("agent_start", async () => {
    reset();
    totalStartMs = Date.now();
  });

  pi.on("before_provider_request", async () => {
    providerRequestCount++;

    // Skip the first request for the user prompt. Measure only resumed requests,
    // e.g. after tool results have been fed back to the provider.
    if (providerRequestCount > 1) {
      pendingProviderLatencyStartMs = Date.now();
    }
  });

  pi.on("message_update", async () => {
    if (pendingProviderLatencyStartMs > 0) {
      providerLatenciesMs.push(Date.now() - pendingProviderLatencyStartMs);
      pendingProviderLatencyStartMs = 0;
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const startedAt = event.message.timestamp;
    const finishedAt = Date.now();
    // Pi sets this timestamp before the request, not at the first visible token.
    // Include hidden reasoning and request latency. Exclude time between requests.
    if (!Number.isFinite(startedAt) || startedAt < totalStartMs || startedAt > finishedAt) {
      requestTimingValid = false;
      return;
    }
    requestMs += finishedAt - startedAt;
    timedAssistantMessages++;
  });

  pi.on("tool_execution_start", async (event) => {
    activeToolStarts.set(event.toolCallId, Date.now());
  });

  pi.on("tool_execution_end", async (event) => {
    const start = activeToolStarts.get(event.toolCallId);
    if (start === undefined) return;
    toolIntervals.push([start, Date.now()]);
    activeToolStarts.delete(event.toolCallId);
  });

  pi.on("agent_end", async (event, ctx) => {
    const totalMs = totalStartMs > 0 ? Date.now() - totalStartMs : 0;
    const usage = turnTokenUsage(event.messages);
    const rate = tokensPerSecond(usage);
    const finishedAt = new Date();
    const stats = formatStats(usage, rate, finishedAt);

    lastStats = stats;
    lastStatsAtMs = Date.now();
    ctx.ui.notify(stats, "info");

    pi.appendEntry("turn-stats", {
      totalMs,
      toolMs: currentToolMs(),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      estimatedTokens: !usage.exact,
      requestMs,
      rateBasis: "full-request",
      avgLatencyMs: average(providerLatenciesMs),
      latenciesMs: [...providerLatenciesMs],
      tokensPerSecond: rate,
      timestamp: Date.now(),
    });
  });

  pi.on("session_before_compact", async () => {
    reshowStatsAfterCompaction = Boolean(lastStats && Date.now() - lastStatsAtMs <= 30_000);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!lastStats || !reshowStatsAfterCompaction) return;
    reshowStatsAfterCompaction = false;

    const stats = lastStats;
    setTimeout(() => {
      ctx.ui.notify(stats, "info");
    }, 100);
  });

  pi.on("session_shutdown", async () => {
    reset();
    lastStats = undefined;
    lastStatsAtMs = 0;
    reshowStatsAfterCompaction = false;
  });
}
