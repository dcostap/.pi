import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SimpleMessengerConfig } from "./types.js";

const DEFAULT_CONFIG: SimpleMessengerConfig = {
  autoJoin: false,
  autoJoinPaths: [],
  inboxPollIntervalMs: 1500,
  heartbeatIntervalMs: 10000,
  messageRetention: 2000,
};

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function matchesPathPattern(cwd: string, patterns: string[]): boolean {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");

  for (const pattern of patterns) {
    const expanded = expandHome(pattern).replace(/\\/g, "/").replace(/\/+$/, "");
    if (expanded.endsWith("/*")) {
      const base = expanded.slice(0, -2);
      if (normalized === base || normalized.startsWith(base + "/")) return true;
      continue;
    }
    if (expanded.endsWith("*")) {
      const prefix = expanded.slice(0, -1);
      if (normalized.startsWith(prefix)) return true;
      continue;
    }
    if (normalized === expanded) return true;
  }

  return false;
}

export function loadConfig(cwd: string): SimpleMessengerConfig {
  const userPath = join(homedir(), ".pi", "agent", "messenger.json");
  const projectPath = join(cwd, ".pi", "messenger.json");

  const merged = {
    ...DEFAULT_CONFIG,
    ...(readJson(userPath) ?? {}),
    ...(readJson(projectPath) ?? {}),
  } as Record<string, unknown>;

  return {
    autoJoin: merged.autoJoin === true,
    autoJoinPaths: Array.isArray(merged.autoJoinPaths)
      ? merged.autoJoinPaths.filter((value): value is string => typeof value === "string")
      : [],
    inboxPollIntervalMs: typeof merged.inboxPollIntervalMs === "number" ? merged.inboxPollIntervalMs : DEFAULT_CONFIG.inboxPollIntervalMs,
    heartbeatIntervalMs: typeof merged.heartbeatIntervalMs === "number" ? merged.heartbeatIntervalMs : DEFAULT_CONFIG.heartbeatIntervalMs,
    messageRetention: typeof merged.messageRetention === "number" ? merged.messageRetention : DEFAULT_CONFIG.messageRetention,
  };
}
