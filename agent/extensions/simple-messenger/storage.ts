import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRegistration,
  ChatMessage,
  IdleWatchRule,
  IdleWatchStore,
  InboxItem,
  PresenceState,
  ProjectInfo,
  ResetContextBeforeMessageRequest,
  ResetContextBeforeMessageResult,
  ThreadSummary,
} from "./types.js";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function projectPaths(project: ProjectInfo) {
  const registryDir = join(project.projectDir, "registry");
  const inboxDir = join(project.projectDir, "inbox");
  const controlResultsDir = join(project.projectDir, "control-results");
  const messagesPath = join(project.projectDir, "messages.jsonl");
  return { registryDir, inboxDir, controlResultsDir, messagesPath };
}

export function ensureProjectDirs(project: ProjectInfo): void {
  const paths = projectPaths(project);
  ensureDir(project.projectDir);
  ensureDir(paths.registryDir);
  ensureDir(paths.inboxDir);
  ensureDir(paths.controlResultsDir);
}

const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TMP_FILE_SUFFIX = ".tmp";
const TMP_FILE_MAX_AGE_MS = 1000 * 60 * 10;

function isTransientRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return !!code && TRANSIENT_RENAME_ERROR_CODES.has(code);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function cleanupOldTmpFiles(dir: string, maxAgeMs = TMP_FILE_MAX_AGE_MS): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const file of files) {
    if (!file.endsWith(TMP_FILE_SUFFIX)) continue;
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs <= cutoff) safeUnlink(fullPath);
    } catch {}
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  cleanupOldTmpFiles(dirname(path));

  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}${TMP_FILE_SUFFIX}`;
  const payload = JSON.stringify(value, null, 2);
  writeFileSync(tmp, payload, "utf8");

  const retryDelaysMs = [0, 10, 25, 50, 100, 200];
  let lastError: unknown = null;

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) sleepSync(delayMs);
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRenameError(error)) break;
    }
  }

  try {
    writeFileSync(path, payload, "utf8");
    safeUnlink(tmp);
    return;
  } catch (error) {
    lastError = error;
  }

  safeUnlink(tmp);
  throw lastError instanceof Error ? lastError : new Error("Failed to atomically write JSON file.");
}

function registryFile(project: ProjectInfo, sessionId: string): string {
  return join(projectPaths(project).registryDir, `${sessionId}.json`);
}

export function writeRegistry(project: ProjectInfo, registration: AgentRegistration): void {
  ensureProjectDirs(project);
  atomicWriteJson(registryFile(project, registration.sessionId), registration);
}

export function removeRegistry(project: ProjectInfo, sessionId: string): void {
  safeUnlink(registryFile(project, sessionId));
}

function processExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readActiveAgents(project: ProjectInfo, staleMs = 1000 * 60 * 60 * 8): AgentRegistration[] {
  ensureProjectDirs(project);
  const { registryDir } = projectPaths(project);
  cleanupOldTmpFiles(registryDir);
  const agents: AgentRegistration[] = [];
  const now = Date.now();

  for (const file of readdirSync(registryDir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(registryDir, file);
    const parsed = safeJsonParse<AgentRegistration>(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== 1) {
      safeUnlink(path);
      continue;
    }

    const normalized: AgentRegistration = {
      ...parsed,
      role: parsed.role?.trim() || "agent",
      presenceState: (parsed.presenceState === "working" ? "working" : "idle") as PresenceState,
      presenceSince: parsed.presenceSince || parsed.joinedAt || parsed.updatedAt || new Date(now).toISOString(),
    };

    const updated = Date.parse(normalized.updatedAt || normalized.joinedAt || "");
    const stale = Number.isFinite(updated) ? now - updated > staleMs : true;

    // Clean up dead sessions immediately instead of waiting for the stale timeout.
    // The timeout remains as a fallback for malformed entries that are missing a usable pid.
    if (typeof normalized.pid !== "number" || !Number.isFinite(normalized.pid) || normalized.pid <= 0) {
      if (stale) {
        safeUnlink(path);
        continue;
      }
    } else if (!processExists(normalized.pid)) {
      safeUnlink(path);
      continue;
    }

    agents.push(normalized);
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

export function getAgentByName(project: ProjectInfo, name: string): AgentRegistration | undefined {
  return readActiveAgents(project).find((agent) => agent.name.toLowerCase() === name.toLowerCase());
}

export function isNameTaken(project: ProjectInfo, name: string, exceptSessionId?: string): boolean {
  return readActiveAgents(project).some((agent) => agent.sessionId !== exceptSessionId && agent.name.toLowerCase() === name.toLowerCase());
}

function appendJsonl(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function trimJsonl(path: string, maxLines: number): void {
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length <= maxLines) return;
    writeFileSync(path, `${lines.slice(lines.length - maxLines).join("\n")}\n`, "utf8");
  } catch {}
}

export function appendMessage(project: ProjectInfo, message: ChatMessage, maxLines: number): void {
  const { messagesPath } = projectPaths(project);
  appendJsonl(messagesPath, message);
  trimJsonl(messagesPath, maxLines);
}

export function readMessages(project: ProjectInfo): ChatMessage[] {
  const { messagesPath } = projectPaths(project);
  if (!existsSync(messagesPath)) return [];
  return readFileSync(messagesPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse<ChatMessage>(line))
    .filter((value): value is ChatMessage => !!value)
    .map((message) => ({
      ...message,
      fromRoleSnapshot: message.fromRoleSnapshot?.trim() || "agent",
    }));
}

export function buildThreads(
  project: ProjectInfo,
  selfSessionId: string,
  currentNames: Map<string, string>,
  currentRoles: Map<string, string>,
): ThreadSummary[] {
  const grouped = new Map<string, ChatMessage[]>();

  for (const message of readMessages(project)) {
    if (message.kind !== "direct") continue;
    const involvesSelf = message.fromSessionId === selfSessionId || message.toSessionIds.includes(selfSessionId);
    if (!involvesSelf) continue;

    const peerSessionId = message.fromSessionId === selfSessionId
      ? (message.toSessionIds[0] ?? "unknown")
      : message.fromSessionId;
    const list = grouped.get(peerSessionId) ?? [];
    list.push(message);
    grouped.set(peerSessionId, list);
  }

  const threads: ThreadSummary[] = [];
  for (const [peerSessionId, messages] of grouped) {
    messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const last = messages[messages.length - 1]!;
    const snapshotName = last.fromSessionId === peerSessionId
      ? last.fromNameSnapshot
      : (last.toNameSnapshots[0] ?? "Unknown");
    const snapshotRole = last.fromSessionId === peerSessionId ? (last.fromRoleSnapshot || "agent") : "agent";
    threads.push({
      peerSessionId,
      peerName: currentNames.get(peerSessionId) ?? snapshotName,
      peerRole: currentRoles.get(peerSessionId) ?? snapshotRole,
      lastAt: last.createdAt,
      preview: buildPreview(last.text),
      messages,
    });
  }

  threads.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return threads;
}

export function inboxDir(project: ProjectInfo, sessionId: string): string {
  return join(projectPaths(project).inboxDir, sessionId);
}

export function ensureInbox(project: ProjectInfo, sessionId: string): void {
  ensureDir(inboxDir(project, sessionId));
}

export function enqueueInboxMessage(project: ProjectInfo, recipientSessionId: string, item: InboxItem): void {
  const dir = inboxDir(project, recipientSessionId);
  ensureDir(dir);
  const id = "requestId" in item ? item.requestId : item.id;
  atomicWriteJson(join(dir, `${Date.now()}-${id}.json`), item);
}

function isResetContextBeforeMessageRequest(value: InboxItem): value is ResetContextBeforeMessageRequest {
  return "controlType" in value && value.controlType === "reset_context_before_message";
}

export function consumeInbox(project: ProjectInfo, sessionId: string): { item: InboxItem; path: string }[] {
  const dir = inboxDir(project, sessionId);
  ensureDir(dir);
  const entries: { item: InboxItem; path: string }[] = [];

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const parsed = safeJsonParse<InboxItem>(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== 1) {
      safeUnlink(path);
      continue;
    }

    if (isResetContextBeforeMessageRequest(parsed)) {
      entries.push({ item: parsed, path });
      continue;
    }

    const message = parsed as ChatMessage;
    entries.push({ item: { ...message, fromRoleSnapshot: message.fromRoleSnapshot?.trim() || "agent" }, path });
  }

  return entries;
}

export function removeInboxMessage(path: string): void {
  safeUnlink(path);
}

export function cleanupInbox(project: ProjectInfo, sessionId: string): void {
  try {
    rmSync(inboxDir(project, sessionId), { recursive: true, force: true });
  } catch {}
}

export function controlResultsDir(project: ProjectInfo, sessionId: string): string {
  return join(projectPaths(project).controlResultsDir, sessionId);
}

export function writeResetContextBeforeMessageResult(project: ProjectInfo, senderSessionId: string, result: ResetContextBeforeMessageResult): void {
  const dir = controlResultsDir(project, senderSessionId);
  ensureDir(dir);
  atomicWriteJson(join(dir, `${result.requestId}.json`), result);
}

export function readResetContextBeforeMessageResult(project: ProjectInfo, senderSessionId: string, requestId: string): ResetContextBeforeMessageResult | null {
  const path = join(controlResultsDir(project, senderSessionId), `${requestId}.json`);
  if (!existsSync(path)) return null;
  const parsed = safeJsonParse<ResetContextBeforeMessageResult>(readFileSync(path, "utf8"));
  if (!parsed || parsed.version !== 1 || parsed.controlType !== "reset_context_before_message_result") return null;
  return parsed;
}

export function removeResetContextBeforeMessageResult(project: ProjectInfo, senderSessionId: string, requestId: string): void {
  safeUnlink(join(controlResultsDir(project, senderSessionId), `${requestId}.json`));
}

export function buildPreview(text: string, max = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function sanitizeFileStem(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}

function watchRulesPath(watcherName: string): string {
  return join(homedir(), ".pi", "agent", "simple-messenger", "idle-watch", `${sanitizeFileStem(watcherName)}.json`);
}

export function readIdleWatchStore(watcherName: string): IdleWatchStore {
  const path = watchRulesPath(watcherName);
  if (!existsSync(path)) return { version: 1, rules: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IdleWatchStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rules)) {
      return { version: 1, rules: [] };
    }

    return {
      version: 1,
      rules: parsed.rules
        .filter((rule): rule is IdleWatchRule => !!rule && rule.version === 1)
        .map((rule) => ({
          version: 1 as const,
          id: rule.id,
          projectKey: rule.projectKey?.trim() || "",
          watcherName: rule.watcherName?.trim() || watcherName,
          enabled: rule.enabled !== false,
          watchFor: rule.watchFor === "working" ? "working" : "idle",
          target: rule.target,
          afterMinutes: typeof rule.afterMinutes === "number" && Number.isFinite(rule.afterMinutes) ? rule.afterMinutes : 0,
          notifiedTargets: rule.notifiedTargets && typeof rule.notifiedTargets === "object" ? rule.notifiedTargets : {},
        }))
        .filter((rule) => rule.projectKey.length > 0),
    };
  } catch {
    return { version: 1, rules: [] };
  }
}

export function writeIdleWatchStore(watcherName: string, store: IdleWatchStore): void {
  const path = watchRulesPath(watcherName);
  atomicWriteJson(path, store);
}

export function formatRelativeTime(timestamp: string): string {
  const deltaMs = Math.max(0, Date.now() - Date.parse(timestamp));
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

