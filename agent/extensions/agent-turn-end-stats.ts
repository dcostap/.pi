import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let totalStartMs = 0;
  let estimatedOutputTokens = 0;
  let activeStreamStartMs = 0;
  let streamMs = 0;
  let providerRequestCount = 0;
  let pendingProviderLatencyStartMs = 0;
  const providerLatenciesMs: number[] = [];
  let lastStats: string | undefined;
  let lastStatsAtMs = 0;
  let reshowStatsAfterCompaction = false;
  let lastTokensPerSecondStatusMs = 0;
  const activeToolStarts = new Map<string, number>();
  const toolIntervals: Array<[number, number]> = [];

  function reset() {
    totalStartMs = 0;
    estimatedOutputTokens = 0;
    activeStreamStartMs = 0;
    streamMs = 0;
    providerRequestCount = 0;
    pendingProviderLatencyStartMs = 0;
    providerLatenciesMs.length = 0;
    lastTokensPerSecondStatusMs = 0;
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

  function estimateTokens(text: string) {
    // Cheap streaming estimate. Final stats prefer provider-reported usage.output.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  function formatTokens(tokens: number) {
    if (tokens < 1000) return `${Math.round(tokens)}`;
    return `${(tokens / 1000).toFixed(1)}k`;
  }

  function tokensPerSecond(tokens: number, elapsedMs: number) {
    return tokens / Math.max(0.001, elapsedMs / 1000);
  }

  function formatTokenRate(tokens: number, elapsedMs: number, estimated = true) {
    const prefix = estimated ? "~" : "";
    return `${prefix}${tokensPerSecond(tokens, elapsedMs).toFixed(1)} tok/s`;
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
  }

  function turnTokenUsage(messages: unknown[]): TurnTokenUsage {
    const usage: TurnTokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      exact: false,
    };

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const maybeMessage = message as {
        role?: unknown;
        usage?: {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
        };
      };
      if (maybeMessage.role !== "assistant") continue;

      const messageUsage = maybeMessage.usage;
      if (!messageUsage) continue;
      usage.exact = true;
      if (typeof messageUsage.input === "number") usage.input += messageUsage.input;
      if (typeof messageUsage.output === "number") usage.output += messageUsage.output;
      if (typeof messageUsage.cacheRead === "number") usage.cacheRead += messageUsage.cacheRead;
      if (typeof messageUsage.cacheWrite === "number") usage.cacheWrite += messageUsage.cacheWrite;
    }

    if (!usage.exact) usage.output = estimatedOutputTokens;
    return usage;
  }

  function formatUsage(usage: TurnTokenUsage) {
    const parts: string[] = [];
    if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
    return parts.join(" ");
  }

  function currentStreamMs() {
    return streamMs + (activeStreamStartMs > 0 ? Date.now() - activeStreamStartMs : 0);
  }

  function formatStats(usage: TurnTokenUsage = { input: 0, output: estimatedOutputTokens, cacheRead: 0, cacheWrite: 0, exact: false }) {
    const totalMs = totalStartMs > 0 ? Date.now() - totalStartMs : 0;
    const toolMs = currentToolMs();
    const usagePart = formatUsage(usage);
    const rateMs = currentStreamMs() || Math.max(0, totalMs - toolMs) || totalMs;
    const avgLatencyMs = average(providerLatenciesMs);
    const latencyPart = avgLatencyMs > 0 ? ` · ${formatDuration(avgLatencyMs)} avg latency` : "";
    const tokenPart = usage.output > 0
      ? ` · ${usagePart}${usagePart ? " · " : ""}${formatTokenRate(usage.output, rateMs, !usage.exact)}`
      : "";

    return `${formatDuration(totalMs)} total · ${formatDuration(toolMs)} tools${latencyPart}${tokenPart}`;
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

  pi.on("message_update", async (event, ctx) => {
    if (pendingProviderLatencyStartMs > 0) {
      providerLatenciesMs.push(Date.now() - pendingProviderLatencyStartMs);
      pendingProviderLatencyStartMs = 0;
    }

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;

    estimatedOutputTokens += estimateTokens(streamEvent.delta);
    if (activeStreamStartMs === 0) activeStreamStartMs = Date.now();

    // Avoid redrawing the footer on every tiny chunk.
    const now = Date.now();
    if (now - lastTokensPerSecondStatusMs < 250) return;
    lastTokensPerSecondStatusMs = now;

    // Keep the estimate updated internally, but do not show live footer/status text.
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || activeStreamStartMs === 0) return;
    streamMs += Date.now() - activeStreamStartMs;
    activeStreamStartMs = 0;
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
    const stats = formatStats(usage);

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
      streamMs: currentStreamMs(),
      avgLatencyMs: average(providerLatenciesMs),
      latenciesMs: [...providerLatenciesMs],
      tokensPerSecond: tokensPerSecond(usage.output, currentStreamMs() || Math.max(0, totalMs - currentToolMs()) || totalMs),
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
