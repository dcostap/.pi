/**
 * Subscription usage for pi.
 *
 * Usage indicator for Codex, and for Claude models served by pi-claude-bridge.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  Text,
  getKeybindings,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readUsageSnapshot, sharedClaudeUsage } from "./_shared/claude-usage-cache.js";

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const LOG_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const STATUS_KEY = "subscription-usage";
const SHOW_THRESHOLD = 80;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const AGENT_DIR = getAgentDir();
const AUTH_FILE = path.join(AGENT_DIR, "auth.json");
const OBSERVATIONS_FILE = path.join(AGENT_DIR, "codex-usage-observations.jsonl");
const CLAUDE_USAGE_CACHE = path.join(AGENT_DIR, "claude-usage-cache.json");
const USAGE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

const PRIMARY_CODEX_PROVIDER_ID = "openai-codex" as const;
const SECONDARY_CODEX_PROVIDER_ID = "openai-codex-secondary" as const;
const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge" as const;
type OAuthProviderId = typeof PRIMARY_CODEX_PROVIDER_ID | typeof SECONDARY_CODEX_PROVIDER_ID;
type ProviderKey = OAuthProviderId | typeof CLAUDE_BRIDGE_PROVIDER_ID;

interface StoredOAuthCredentials {
  access?: string;
  refresh?: string;
  expires?: number;
}

type AuthData = Partial<Record<OAuthProviderId, StoredOAuthCredentials>> & Record<string, any>;

interface ResetCreditData {
  status?: string;
  expiresAt?: string;
  title?: string;
}

type ResetConsumeOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" | "unknown";

interface ResetConsumeResult {
  outcome: ResetConsumeOutcome;
  windowsReset?: number;
  raw: any;
}

interface UsageData {
  session?: number;
  weekly?: number;
  resetCreditsAvailable?: number;
  resetCredits?: ResetCreditData[];
  resetCreditsExpireText?: string;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  sessionResetAfterSeconds?: number;
  weeklyResetAfterSeconds?: number;
  sessionResetAt?: number;
  weeklyResetAt?: number;
  sessionWindowMinutes?: number;
  weeklyWindowMinutes?: number;
  error?: string;
}

interface UsageRollup {
  type: "pi_usage_rollup";
  from: string;
  to: string;
  reason: string;
  provider: string;
  model: string;
  cwd?: string;
  sessionFile?: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  estimatedCost: number;
}

interface HeadersLike {
  get(name: string): string | null;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: HeadersLike;
  json(): Promise<any>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface JsonRequestSuccess {
  ok: true;
  data: any;
  status: number;
  headers?: HeadersLike;
}

interface JsonRequestError {
  ok: false;
  error: string;
  status: number | null;
  headers?: HeadersLike;
}

type JsonRequestResult = JsonRequestSuccess | JsonRequestError;

interface SubscriptionItem {
  name: string;
  provider: ProviderKey;
  data: UsageData | null;
  isActive: boolean;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timeout";
    return error.message || String(error);
  }
  return String(error);
}

function asObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<JsonRequestResult> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal;
    signal.throwIfAborted();
    const response = await fetchFn(url, { ...init, signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status, headers: response.headers };
    }

    try {
      const data = await response.json();
      return { ok: true, data, status: response.status, headers: response.headers };
    } catch {
      return { ok: false, error: "invalid JSON response", status: response.status, headers: response.headers };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), status: null };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function formatResetAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";

  const date = new Date(Date.now() + seconds * 1000);
  const day = String(date.getDate());
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(date).toLowerCase();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${formatDuration(seconds)} (${day} ${month} ${hours}:${minutes})`;
}

function readAuth(authFile = AUTH_FILE): AuthData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    return asObject(parsed) as AuthData;
  } catch {
    return null;
  }
}

function usageCacheIdentity(providerId: OAuthProviderId): string | undefined {
  // Token changes invalidate the cache. Never show a previous account's usage.
  const access = readAuth()?.[providerId]?.access;
  if (!access) return undefined;
  return createHash("sha256").update(access).digest("hex");
}

function refreshCountdowns(data: UsageData): UsageData {
  const refreshed = { ...data };
  for (const window of ["session", "weekly"] as const) {
    const resetAt = data[`${window}ResetAt`];
    if (resetAt === undefined) continue;
    const seconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
    refreshed[`${window}ResetAfterSeconds`] = seconds;
    refreshed[`${window}ResetsIn`] = window === "session" ? formatDuration(seconds) : formatResetAt(seconds);
    // An old window cannot describe usage after its reset.
    if (resetAt <= Date.now()) refreshed[window] = undefined;
  }
  refreshed.resetCreditsExpireText = formatResetCreditExpiries(data.resetCredits);
  return refreshed;
}

function readCachedUsage(providerId: ProviderKey): UsageData | null {
  try {
    let snapshot;
    if (providerId === CLAUDE_BRIDGE_PROVIDER_ID) {
      snapshot = readUsageSnapshot<UsageData>(CLAUDE_USAGE_CACHE);
    } else {
      const cached = readUsageSnapshot<{ identity: string; usage: UsageData }>(path.join(AGENT_DIR, `${providerId}-usage-cache.json`));
      const identity = usageCacheIdentity(providerId);
      if (!identity || cached?.data?.identity !== identity) return null;
      snapshot = { attemptedAt: cached.attemptedAt, data: cached.data.usage };
    }
    const maxAge = providerId === CLAUDE_BRIDGE_PROVIDER_ID ? 60 * 60 * 1000 : USAGE_CACHE_MAX_AGE_MS;
    if (!snapshot?.data || snapshot.data.error || Date.now() - snapshot.attemptedAt > maxAge) return null;
    return refreshCountdowns(snapshot.data);
  } catch {
    return null;
  }
}

function saveCachedUsage(providerId: OAuthProviderId, identity: string, data: UsageData): void {
  if (data.error) return;
  const file = path.join(AGENT_DIR, `${providerId}-usage-cache.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ attemptedAt: Date.now(), data: { identity, usage: data } }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // Cache failures must not stop usage updates.
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function appendObservation(record: Record<string, any>, logFile = OBSERVATIONS_FILE): boolean {
  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function readResetAtSeconds(window: any): number | undefined {
  if (typeof window?.reset_at === "number" && Number.isFinite(window.reset_at)) return window.reset_at;
  if (typeof window?.resets_at === "number" && Number.isFinite(window.resets_at)) return window.resets_at;
  return undefined;
}

function readAvailableResetCredits(value: unknown): number | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  const count = obj.available_count;
  if (typeof count === "number" && Number.isFinite(count)) return Math.max(0, Math.trunc(count));
  if (typeof count === "string" && count.trim()) {
    const parsed = Number(count);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return undefined;
}

function readResetCredits(value: unknown): ResetCreditData[] | undefined {
  const obj = asObject(value);
  const credits = Array.isArray(obj?.credits) ? obj.credits : undefined;
  if (!credits) return undefined;
  return credits
    .map((item) => {
      const credit = asObject(item);
      if (!credit) return undefined;
      return {
        status: typeof credit.status === "string" ? credit.status : undefined,
        expiresAt: typeof credit.expires_at === "string" ? credit.expires_at : undefined,
        title: typeof credit.title === "string" ? credit.title : undefined,
      };
    })
    .filter((credit): credit is ResetCreditData => !!credit);
}

function formatResetCreditExpiry(expiresAtMs: number): string {
  const minutes = Math.round((expiresAtMs - Date.now()) / 60000);
  if (minutes <= 0) return "expired";
  if (minutes < 90) return `~${minutes}m`;
  if (minutes < 60 * 48) return `~${Math.round(minutes / 60)}h`;
  return `~${Math.round(minutes / 1440)}d`;
}

function formatResetCreditExpiries(credits: ResetCreditData[] | undefined): string | undefined {
  const expiring = (credits ?? [])
    .map((credit) => ({ credit, expiresAtMs: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN }))
    .filter((item) => Number.isFinite(item.expiresAtMs) && (!item.credit.status || item.credit.status === "available"))
    .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
  if (expiring.length === 0) return undefined;
  const shown = expiring.slice(0, 3).map((item, index) => `#${index + 1} ${formatResetCreditExpiry(item.expiresAtMs)}`);
  const hidden = expiring.length - shown.length;
  return `${shown.join(" · ")}${hidden > 0 ? ` · +${hidden}` : ""}`;
}

function extractJwtAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const claims = asObject(decoded)?.["https://api.openai.com/auth"];
    const accountId = asObject(claims)?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function codexUsageHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    accept: "application/json",
    "OAI-Language": "en",
    originator: "pi",
  };
  const accountId = extractJwtAccountId(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

function createResetRedeemRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function parseResetConsumeResult(payload: any): ResetConsumeResult {
  const root = asObject(payload) ?? {};
  const code = typeof root.code === "string" ? root.code : undefined;
  const outcome: ResetConsumeOutcome =
    code === "reset" || code === "already_redeemed" || code === "nothing_to_reset" || code === "no_credit"
      ? code
      : "unknown";
  const windowsReset = typeof root.windows_reset === "number" && Number.isFinite(root.windows_reset)
    ? Math.max(0, Math.trunc(root.windows_reset))
    : undefined;
  return { outcome, windowsReset, raw: payload };
}

function formatResetConsumeResult(result: ResetConsumeResult): string {
  if (result.outcome === "reset") {
    return `Codex rate limits reset${result.windowsReset === undefined ? "" : ` (${result.windowsReset} window${result.windowsReset === 1 ? "" : "s"})`}.`;
  }
  if (result.outcome === "already_redeemed") return "Reset already applied; refreshed usage.";
  if (result.outcome === "nothing_to_reset") return "No active Codex limit to reset.";
  if (result.outcome === "no_credit") return "No banked resets available.";
  return "Reset response was not recognized; refreshed usage.";
}

function resetAtMs(window: any): number | undefined {
  const resetAtSeconds = readResetAtSeconds(window);
  if (resetAtSeconds !== undefined) return resetAtSeconds * 1000;
  if (typeof window?.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)) {
    return Date.now() + window.reset_after_seconds * 1000;
  }
  return undefined;
}

function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  if (value >= 0 && value <= 1) {
    if (Number.isInteger(value)) return value;
    return value * 100;
  }

  if (value >= 0 && value <= 100) return value;
  return null;
}

type CodexWindowKind = "session" | "weekly";

interface NormalizedCodexWindow {
  raw: any;
  usedPercent: number;
  windowMinutes?: number;
}

function readWindowMinutes(window: any): number | undefined {
  if (typeof window?.limit_window_seconds === "number" && Number.isFinite(window.limit_window_seconds)) {
    return window.limit_window_seconds / 60;
  }
  if (typeof window?.window_minutes === "number" && Number.isFinite(window.window_minutes)) {
    return window.window_minutes;
  }
  return undefined;
}

function normalizeCodexWindow(window: any): NormalizedCodexWindow | undefined {
  const usedPercent = readPercentCandidate(window?.used_percent);
  if (usedPercent === null) return undefined;
  return { raw: window, usedPercent, windowMinutes: readWindowMinutes(window) };
}

function isApproximateWindow(minutes: number | undefined, expectedMinutes: number): boolean {
  return minutes !== undefined && minutes >= expectedMinutes * 0.95 && minutes <= expectedMinutes * 1.05;
}

function classifyCodexWindow(window: NormalizedCodexWindow): CodexWindowKind | undefined {
  if (isApproximateWindow(window.windowMinutes, 5 * 60)) return "session";
  if (isApproximateWindow(window.windowMinutes, 7 * 24 * 60)) return "weekly";
  return undefined;
}

function identifyCodexWindows(primaryRaw: any, secondaryRaw: any): Partial<Record<CodexWindowKind, NormalizedCodexWindow>> {
  const primary = normalizeCodexWindow(primaryRaw);
  const secondary = normalizeCodexWindow(secondaryRaw);
  const identified: Partial<Record<CodexWindowKind, NormalizedCodexWindow>> = {};
  const unknown: Array<{ window: NormalizedCodexWindow; position: "primary" | "secondary" }> = [];

  for (const candidate of [
    primary && { window: primary, position: "primary" as const },
    secondary && { window: secondary, position: "secondary" as const },
  ]) {
    if (!candidate) continue;
    const kind = classifyCodexWindow(candidate.window);
    if (kind) {
      if (!identified[kind]) identified[kind] = candidate.window;
      continue;
    }
    unknown.push(candidate);
  }

  // Compatibility for older responses that omitted window duration. Duration
  // always wins; position is only a fallback for the remaining unknown window.
  for (const candidate of unknown) {
    if (identified.weekly && !identified.session) identified.session = candidate.window;
    else if (identified.session && !identified.weekly) identified.weekly = candidate.window;
    else if (candidate.position === "primary" && !identified.session) identified.session = candidate.window;
    else if (candidate.position === "secondary" && !identified.weekly) identified.weekly = candidate.window;
  }

  return identified;
}

async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const headers = codexUsageHeaders(token);
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const windows = identifyCodexWindows(
    result.data?.rate_limit?.primary_window,
    result.data?.rate_limit?.secondary_window,
  );
  const session = windows.session;
  const weekly = windows.weekly;
  let resetCreditsAvailable = readAvailableResetCredits(result.data?.rate_limit_reset_credits);
  let resetCredits: ResetCreditData[] | undefined;

  if (resetCreditsAvailable === undefined || resetCreditsAvailable > 0) {
    const resetCreditsResult = await requestJson(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      { headers },
      config,
    );
    if (resetCreditsResult.ok) {
      resetCreditsAvailable = readAvailableResetCredits(resetCreditsResult.data) ?? resetCreditsAvailable;
      resetCredits = readResetCredits(resetCreditsResult.data);
    }
  }

  return {
    session: session?.usedPercent,
    weekly: weekly?.usedPercent,
    resetCreditsAvailable,
    resetCredits,
    resetCreditsExpireText: formatResetCreditExpiries(resetCredits),
    sessionResetsIn:
      typeof session?.raw?.reset_after_seconds === "number" ? formatDuration(session.raw.reset_after_seconds) : undefined,
    weeklyResetsIn:
      typeof weekly?.raw?.reset_after_seconds === "number" ? formatResetAt(weekly.raw.reset_after_seconds) : undefined,
    sessionResetAfterSeconds:
      typeof session?.raw?.reset_after_seconds === "number" ? session.raw.reset_after_seconds : undefined,
    weeklyResetAfterSeconds:
      typeof weekly?.raw?.reset_after_seconds === "number" ? weekly.raw.reset_after_seconds : undefined,
    sessionResetAt: session ? resetAtMs(session.raw) : undefined,
    weeklyResetAt: weekly ? resetAtMs(weekly.raw) : undefined,
    sessionWindowMinutes: session?.windowMinutes,
    weeklyWindowMinutes: weekly?.windowMinutes,
  };
}

// pi-claude-bridge runs Claude Code, so Claude Code's login is the account that
// pays for bridge turns. Read its token only: Claude Code refreshes it during
// bridge turns, and a refresh here would rotate the refresh token under it.
function claudeCredentialsFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
}

function readClaudeAccess(): { access?: string; error?: string } {
  let oauth: Record<string, any> | null | undefined;
  try {
    oauth = asObject(asObject(JSON.parse(fs.readFileSync(claudeCredentialsFile(), "utf-8")))?.claudeAiOauth);
  } catch {
    return { error: "no Claude Code login found (run claude, then /login)" };
  }
  if (typeof oauth?.accessToken !== "string") return { error: "no Claude Code login found (run claude, then /login)" };
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
    return { error: "Claude Code login expired; send a message to a Claude model to refresh it" };
  }
  return { access: oauth.accessToken };
}

// utilization is a percent (0-100); resets_at is an ISO date.
function readClaudeWindow(window: any): { percent: number; resetAfterSeconds?: number; resetAt?: number } | undefined {
  const percent = window?.utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const resetAt = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  if (!Number.isFinite(resetAt)) return { percent };
  return { percent, resetAt, resetAfterSeconds: Math.max(0, Math.round((resetAt - Date.now()) / 1000)) };
}

// The endpoint Claude Code's own /usage reads.
async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://api.anthropic.com/api/oauth/usage",
    { headers: { Authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20" } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const session = readClaudeWindow(result.data?.five_hour);
  const weekly = readClaudeWindow(result.data?.seven_day);
  return {
    session: session?.percent,
    weekly: weekly?.percent,
    sessionResetsIn: session?.resetAfterSeconds === undefined ? undefined : formatDuration(session.resetAfterSeconds),
    weeklyResetsIn: weekly?.resetAfterSeconds === undefined ? undefined : formatResetAt(weekly.resetAfterSeconds),
    sessionResetAfterSeconds: session?.resetAfterSeconds,
    weeklyResetAfterSeconds: weekly?.resetAfterSeconds,
    sessionResetAt: session?.resetAt,
    weeklyResetAt: weekly?.resetAt,
    sessionWindowMinutes: 5 * 60,
    weeklyWindowMinutes: 7 * 24 * 60,
  };
}

async function consumeCodexResetCredit(token: string, redeemRequestId: string, config: RequestConfig = {}): Promise<ResetConsumeResult> {
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    {
      method: "POST",
      headers: {
        ...codexUsageHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    },
    config,
  );

  if (!result.ok) throw new Error(`Reset request failed (${result.status ?? "network"}): ${result.error}`);
  return parseResetConsumeResult(result.data);
}

function detectProvider(model: { provider?: string; id?: string; name?: string; api?: string } | undefined | null): ProviderKey {
  const provider = (model?.provider || "").toLowerCase();
  if (provider === SECONDARY_CODEX_PROVIDER_ID) return SECONDARY_CODEX_PROVIDER_ID;
  if (provider === CLAUDE_BRIDGE_PROVIDER_ID) return CLAUDE_BRIDGE_PROVIDER_ID;
  return PRIMARY_CODEX_PROVIDER_ID;
}

function hasCredentials(providerId: ProviderKey): boolean {
  if (providerId === CLAUDE_BRIDGE_PROVIDER_ID) return fs.existsSync(claudeCredentialsFile());
  const auth = readAuth();
  return !!(auth?.[providerId]?.access || auth?.[providerId]?.refresh);
}

function providerDisplayName(providerId: ProviderKey): string {
  if (providerId === CLAUDE_BRIDGE_PROVIDER_ID) return "Claude";
  return providerId === SECONDARY_CODEX_PROVIDER_ID ? "Codex Secondary" : "Codex";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

function shouldRenderFooter(data: UsageData | null): data is UsageData {
  if (!data || !!data.error) return false;
  return (data.session ?? 0) > SHOW_THRESHOLD || (data.weekly ?? 0) > SHOW_THRESHOLD;
}

class UsageSelectorComponent extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private hintText: Text;
  private tui: any;
  private theme: any;
  private onCancelCallback: () => void;
  private allItems: SubscriptionItem[] = [];
  private filteredItems: SubscriptionItem[] = [];
  private selectedIndex = 0;
  private loading = true;
  private activeProvider: ProviderKey;
  private fetchFn: () => Promise<UsageData | null>;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: any,
    theme: any,
    activeProvider: ProviderKey,
    fetchUsage: () => Promise<UsageData | null>,
    onCancel: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.activeProvider = activeProvider;
    this.fetchFn = fetchUsage;
    this.onCancelCallback = onCancel;

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(new Spacer(1));

    this.hintText = new Text(theme.fg("dim", "Fetching Codex usage…"), 0, 0);
    this.addChild(this.hintText);
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    this.fetchFn()
      .then((result) => {
        this.loading = false;
        this.buildItems(result);
        this.updateList();
        this.tui.requestRender();
      })
      .catch(() => {
        this.loading = false;
        this.hintText.setText(theme.fg("error", "Failed to fetch usage data"));
        this.tui.requestRender();
      });

    this.updateList();
  }

  private buildItems(result: UsageData | null) {
    this.allItems = [
      {
        name: providerDisplayName(this.activeProvider),
        provider: this.activeProvider,
        data: result,
        isActive: true,
      },
    ];

    this.filteredItems = this.allItems;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private filterItems(query: string) {
    if (!query) {
      this.filteredItems = this.allItems;
    } else {
      const q = query.toLowerCase();
      this.filteredItems = this.allItems.filter(
        (item) => item.name.toLowerCase().includes(q) || item.provider.toLowerCase().includes(q),
      );
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private renderBar(pct: number, width = 16): string {
    const value = clampPercent(pct);
    const filled = Math.round((value / 100) * width);
    const color = colorForPercent(value);
    const full = "█".repeat(Math.max(0, filled));
    const empty = "░".repeat(Math.max(0, width - filled));
    return this.theme.fg(color, full) + this.theme.fg("dim", empty);
  }

  private renderItem(item: SubscriptionItem, isSelected: boolean) {
    const t = this.theme;
    const pointer = isSelected ? t.fg("accent", "→ ") : "  ";
    const activeBadge = item.isActive ? t.fg("success", " ✓") : "";
    const name = isSelected ? t.fg("accent", t.bold(item.name)) : item.name;

    this.listContainer.addChild(new Text(`${pointer}${name}${activeBadge}`, 0, 0));

    const indent = "    ";

    if (!item.data) {
      this.listContainer.addChild(new Text(indent + t.fg("dim", "No usage data"), 0, 0));
    } else if (item.data.error) {
      this.listContainer.addChild(new Text(indent + t.fg("error", item.data.error), 0, 0));
    } else {
      const session = item.data.session === undefined ? undefined : clampPercent(item.data.session);
      const weekly = item.data.weekly === undefined ? undefined : clampPercent(item.data.weekly);

      const sessionReset = item.data.sessionResetsIn
        ? t.fg("dim", `  resets in ${item.data.sessionResetsIn}`)
        : "";
      const weeklyReset = item.data.weeklyResetsIn
        ? t.fg("dim", `  resets in ${item.data.weeklyResetsIn}`)
        : "";

      this.listContainer.addChild(new Text(
        indent + t.fg("muted", "Session  ") + (session === undefined
          ? t.fg("dim", "unavailable")
          : this.renderBar(session) + " " + t.fg(colorForPercent(session), `${session}%`.padStart(4)) + sessionReset),
        0,
        0,
      ));

      this.listContainer.addChild(new Text(
        indent + t.fg("muted", "Weekly   ") + (weekly === undefined
          ? t.fg("dim", "unavailable")
          : this.renderBar(weekly) + " " + t.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) + weeklyReset),
        0,
        0,
      ));

      const resets = item.data.resetCreditsAvailable;
      this.listContainer.addChild(
        new Text(
          indent +
            t.fg("muted", "RESETS   ") +
            (resets === undefined ? t.fg("dim", "unknown") : t.fg(resets > 0 ? "success" : "dim", String(resets))) +
            (item.data.resetCreditsExpireText ? t.fg("dim", `  expires ${item.data.resetCreditsExpireText}`) : ""),
          0,
          0,
        ),
      );

      if (!((item.data.session ?? 0) > SHOW_THRESHOLD || (item.data.weekly ?? 0) > SHOW_THRESHOLD)) {
        this.listContainer.addChild(
          new Text(indent + t.fg("dim", `Footer hidden below ${SHOW_THRESHOLD}% threshold`), 0, 0),
        );
      }
    }

    this.listContainer.addChild(new Spacer(1));
  }

  private updateList() {
    this.listContainer.clear();

    if (this.loading) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  Loading…"), 0, 0));
      return;
    }

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching providers"), 0, 0));
      return;
    }

    for (let i = 0; i < this.filteredItems.length; i++) {
      this.renderItem(this.filteredItems[i]!, i === this.selectedIndex);
    }
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();

    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
      this.onCancelCallback();
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filterItems(this.searchInput.getValue());
    this.updateList();
  }
}

export default function (pi: ExtensionAPI) {
  const state = {
    usage: null as UsageData | null,
    lastPoll: 0,
    activeProvider: PRIMARY_CODEX_PROVIDER_ID as ProviderKey,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollQueued = false;
  let sessionController = new AbortController();
  let ctx: any = null;
  let lastLoggedSnapshotAt = 0;
  let lastLoggedSnapshotKey: string | null = null;
  let lastRollupFlushAt = 0;
  const rollups = new Map<string, UsageRollup>();
  let resetInFlight = false;
  let pendingResetRedeemRequestId: string | undefined;

  function renderPercent(theme: any, value: number): string {
    const v = clampPercent(value);
    return theme.fg(colorForPercent(v), `${v}%`);
  }

  function renderBar(theme: any, value: number): string {
    const v = clampPercent(value);
    const width = 8;
    const filled = Math.round((v / 100) * width);
    const full = "█".repeat(Math.max(0, Math.min(width, filled)));
    const empty = "░".repeat(Math.max(0, width - filled));
    return theme.fg(colorForPercent(v), full) + theme.fg("dim", empty);
  }

  async function getFreshCodexAccess(
    providerId: OAuthProviderId,
  ): Promise<{ access?: string; error?: string }> {
    if (!hasCredentials(providerId)) {
      return { error: `missing Codex credentials (try /login ${providerId})` };
    }

    try {
      // Resolve through Pi's provider runtime instead of refreshing auth.json
      // ourselves. This selects the OAuth implementation registered for the
      // exact provider ID and persists refreshed credentials under that ID.
      const resolved = await ctx?.modelRegistry.getProviderAuth(providerId);
      const access = resolved?.auth?.apiKey;
      return access ? { access } : { error: "missing access token (try /login again)" };
    } catch (error) {
      return { error: `auth refresh failed (${toErrorMessage(error)})` };
    }
  }

  async function confirmUsageReset(
    _ctx: ExtensionContext,
    data: UsageData,
    providerId: OAuthProviderId,
  ): Promise<boolean> {
    if (!_ctx.hasUI) return false;

    return _ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      let input = "";
      const fitLine = (line: string, width: number): string => truncateToWidth(line, Math.max(0, width), "");
      const renderUsage = () =>
        `Current usage: session ${data.session === undefined ? "unavailable" : `${clampPercent(data.session)}%`}, weekly ${data.weekly === undefined ? "unavailable" : `${clampPercent(data.weekly)}%`}`;
      const renderResets = () => {
        const count = data.resetCreditsAvailable === undefined ? "unknown" : String(data.resetCreditsAvailable);
        return `Banked resets: ${count}${data.resetCreditsExpireText ? ` (expires ${data.resetCreditsExpireText})` : ""}`;
      };

      return {
        render(width: number) {
          const separator = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
          return [
            separator,
            fitLine(theme.bold(`Confirm ${providerDisplayName(providerId)} usage reset`), width),
            fitLine(theme.fg("warning", "This will redeem exactly one banked Codex rate-limit reset."), width),
            "",
            fitLine(renderUsage(), width),
            fitLine(renderResets(), width),
            "",
            fitLine("Type yes and press Enter to perform the reset, or Esc/Ctrl-C to cancel.", width),
            fitLine(`${theme.fg("muted", "> ")}${input}`, width),
            separator,
          ];
        },
        invalidate() {},
        handleInput(keyData: string) {
          if (keyData === "\x03" || keyData === "escape" || keyData.includes("\x1b")) {
            done(false);
            return;
          }
          if (keyData === "\r" || keyData === "\n" || keyData === "enter") {
            done(input.trim() === "yes");
            return;
          }
          if (keyData === "\b" || keyData === "\x7f" || keyData === "backspace") {
            input = input.slice(0, -1);
            tui.requestRender();
            return;
          }
          if (keyData.length === 1 && keyData >= " " && keyData !== "\x7f") {
            input += keyData;
            tui.requestRender();
          }
        },
      };
    });
  }

  function updateStatus() {
    const active = state.activeProvider;
    const data = state.usage;

    if (!ctx?.hasUI) return;

    if (!hasCredentials(active)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    if (!shouldRenderFooter(data)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const session = data.session === undefined ? undefined : clampPercent(data.session);
    const weekly = data.weekly === undefined ? undefined : clampPercent(data.weekly);

    const sessionReset = data.sessionResetsIn ? theme.fg("dim", ` ⟳ ${data.sessionResetsIn}`) : "";
    const weeklyReset = data.weeklyResetsIn ? theme.fg("dim", ` ⟳ ${data.weeklyResetsIn}`) : "";
    const resetBank = data.resetCreditsAvailable === undefined
      ? ""
      : theme.fg("muted", " RESETS ") +
        theme.fg(data.resetCreditsAvailable > 0 ? "success" : "dim", String(data.resetCreditsAvailable)) +
        (data.resetCreditsExpireText ? theme.fg("dim", ` exp ${data.resetCreditsExpireText}`) : "");

    const usageParts: string[] = [];
    if (session !== undefined) {
      usageParts.push(theme.fg("muted", "S ") + renderBar(theme, session) + " " + renderPercent(theme, session) + sessionReset);
    }
    if (weekly !== undefined) {
      usageParts.push(theme.fg("muted", "W ") + renderBar(theme, weekly) + " " + renderPercent(theme, weekly) + weeklyReset);
    }
    const status = theme.fg("dim", `${providerDisplayName(active)} `) + usageParts.join(" ") + resetBank;

    ctx.ui.setStatus(STATUS_KEY, status);
  }

  function updateProviderFrom(modelLike: any): boolean {
    const previous = state.activeProvider;
    state.activeProvider = detectProvider(modelLike);

    if (previous !== state.activeProvider) {
      // Never display one account's quota while the other account is active.
      state.usage = readCachedUsage(state.activeProvider);
      updateStatus();
      return true;
    }

    return false;
  }

  function getSessionFile(): string | undefined {
    try {
      return ctx?.sessionManager?.getSessionFile?.();
    } catch {
      return undefined;
    }
  }

  function snapshotKey(data: UsageData): string {
    // Keep change detection focused on weekly quota movement. Session quota is
    // still logged in snapshots, but it changes too often to drive persistence.
    return [data.weekly, data.weeklyWindowMinutes ?? ""].join("|");
  }

  function maybeLogQuotaSnapshot(reason: string, force = false): boolean {
    const data = state.usage;
    if (!data || data.error || state.activeProvider === CLAUDE_BRIDGE_PROVIDER_ID) return false;

    const now = Date.now();
    const key = snapshotKey(data);
    const stale = now - lastLoggedSnapshotAt >= LOG_SNAPSHOT_INTERVAL_MS;
    const changed = key !== lastLoggedSnapshotKey;
    if (!force && !changed && !stale) return false;

    const wrote = appendObservation({
      type: "codex_quota_snapshot",
      timestamp: toIso(now),
      reason: force ? reason : changed ? `${reason}_changed` : `${reason}_stale`,
      provider: state.activeProvider,
      activeProvider: state.activeProvider,
      model: ctx?.model?.id,
      cwd: ctx?.cwd,
      sessionFile: getSessionFile(),
      sessionPercent: data.session,
      weeklyPercent: data.weekly,
      sessionResetAfterSeconds: data.sessionResetAfterSeconds,
      weeklyResetAfterSeconds: data.weeklyResetAfterSeconds,
      sessionResetAt: data.sessionResetAt,
      weeklyResetAt: data.weeklyResetAt,
      resetCreditsAvailable: data.resetCreditsAvailable,
      resetCreditsExpireText: data.resetCreditsExpireText,
      sessionWindowMinutes: data.sessionWindowMinutes,
      weeklyWindowMinutes: data.weeklyWindowMinutes,
    });

    if (wrote) {
      lastLoggedSnapshotAt = now;
      lastLoggedSnapshotKey = key;
    }
    return wrote;
  }

  function aggregatePiUsage(messages: any[] | undefined) {
    if (!Array.isArray(messages)) return;

    const now = Date.now();
    const sessionFile = getSessionFile();
    for (const message of messages) {
      if (message?.role !== "assistant") continue;
      if (message.provider !== PRIMARY_CODEX_PROVIDER_ID && message.provider !== SECONDARY_CODEX_PROVIDER_ID) continue;
      const usage = message.usage;
      if (!usage) continue;

      const model = message.model ?? "unknown";
      const key = `${message.provider}/${model}`;
      let rollup = rollups.get(key);
      if (!rollup) {
        rollup = {
          type: "pi_usage_rollup",
          from: toIso(now),
          to: toIso(now),
          reason: "agent_end",
          provider: message.provider,
          model,
          cwd: ctx?.cwd,
          sessionFile,
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          estimatedCost: 0,
        };
        rollups.set(key, rollup);
      }

      rollup.to = toIso(now);
      rollup.cwd = ctx?.cwd;
      rollup.sessionFile = sessionFile;
      rollup.calls += 1;
      rollup.input += usage.input || 0;
      rollup.output += usage.output || 0;
      rollup.cacheRead += usage.cacheRead || 0;
      rollup.cacheWrite += usage.cacheWrite || 0;
      rollup.totalTokens += usage.totalTokens || 0;
      rollup.estimatedCost += usage.cost?.total || 0;
    }
  }

  function flushPiUsageRollups(reason: string, force = false) {
    if (rollups.size === 0) return;
    const now = Date.now();
    if (!force && now - lastRollupFlushAt < LOG_SNAPSHOT_INTERVAL_MS) return;

    for (const rollup of rollups.values()) {
      appendObservation({ ...rollup, reason, flushedAt: toIso(now) });
    }
    rollups.clear();
    lastRollupFlushAt = now;
  }

  async function fetchUsage(providerId: ProviderKey, manual = false, signal?: AbortSignal): Promise<UsageData> {
    if (providerId === CLAUDE_BRIDGE_PROVIDER_ID) {
      const data = await sharedClaudeUsage<UsageData>(CLAUDE_USAGE_CACHE, async () => {
        const auth = readClaudeAccess();
        return auth.access ? fetchClaudeUsage(auth.access) : { error: auth.error ?? "missing Claude access token" };
      }, manual) ?? { error: "Claude usage refresh is in progress in another Pi session." };
      return refreshCountdowns(data);
    }
    const auth = await getFreshCodexAccess(providerId);
    signal?.throwIfAborted();
    if (!auth.access) return { session: 0, weekly: 0, error: auth.error ?? "missing access token (try /login again)" };
    const identity = createHash("sha256").update(auth.access).digest("hex");
    const data = await fetchCodexUsage(auth.access, { signal });
    signal?.throwIfAborted();
    saveCachedUsage(providerId, identity, data);
    return data;
  }

  async function runPoll(reason: string, forceLog = false) {
    const controller = sessionController;
    if (controller.signal.aborted) return;
    const providerId = state.activeProvider;
    // A queued Codex timer must not poll Claude after a model switch.
    if (providerId === CLAUDE_BRIDGE_PROVIDER_ID && reason !== "claude_inference") return;
    if (!hasCredentials(providerId)) {
      state.usage = null;
      state.lastPoll = Date.now();
      updateStatus();
      return;
    }

    const usage = await fetchUsage(providerId, false, controller.signal);

    // A model switch may have happened while the request was in flight.
    if (controller !== sessionController || controller.signal.aborted || state.activeProvider !== providerId) return;
    state.usage = usage;

    state.lastPoll = Date.now();
    updateStatus();
    if (maybeLogQuotaSnapshot(reason, forceLog)) flushPiUsageRollups("quota_snapshot");
  }

  async function poll(reason = "periodic", forceLog = false) {
    if (pollInFlight) {
      pollQueued = true;
      await pollInFlight;
      return;
    }

    do {
      pollQueued = false;
      pollInFlight = runPoll(reason, forceLog)
        .catch(() => {
          // Never crash extension event handlers on transient polling errors.
        })
        .finally(() => {
          pollInFlight = null;
        });

      await pollInFlight;
    } while (pollQueued && !sessionController.signal.aborted);
  }

  pi.on("session_start", (_event, _ctx) => {
    sessionController.abort();
    sessionController = new AbortController();
    ctx = _ctx;
    updateProviderFrom(_ctx.model);
    state.usage = readCachedUsage(state.activeProvider);
    updateStatus();

    if (state.activeProvider !== CLAUDE_BRIDGE_PROVIDER_ID) void poll("session_start", true);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (state.activeProvider !== CLAUDE_BRIDGE_PROVIDER_ID) void poll("periodic");
    }, POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    sessionController.abort();
    pollQueued = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    flushPiUsageRollups("session_shutdown", true);

    if (_ctx?.hasUI) {
      _ctx.ui.setStatus(STATUS_KEY, undefined);
      _ctx.ui.setStatus("codex-usage-threshold", undefined);
    }
  });

  pi.on("turn_start", async (_event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(_ctx.model);
    if (state.activeProvider === CLAUDE_BRIDGE_PROVIDER_ID) checkClaudeUsage(_ctx);
    if (changed && state.activeProvider !== CLAUDE_BRIDGE_PROVIDER_ID) await poll("turn_start_model_changed", true);
  });

  pi.on("model_select", async (event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(event.model ?? _ctx.model);
    if (changed && state.activeProvider !== CLAUDE_BRIDGE_PROVIDER_ID) await poll("model_select", true);
  });

  // Check when inference starts and while a long response streams.
  // Check at most once a minute locally; the shared cache enforces the one-hour limit.
  let lastClaudeStreamCheck = 0;
  function checkClaudeUsage(_ctx: ExtensionContext) {
    if (Date.now() - lastClaudeStreamCheck < 60_000) return;
    lastClaudeStreamCheck = Date.now();
    ctx = _ctx;
    if (state.activeProvider === CLAUDE_BRIDGE_PROVIDER_ID) void poll("claude_inference");
  }
  pi.on("message_update", (event, _ctx) => {
    if (event.message.role === "assistant" && event.message.provider === CLAUDE_BRIDGE_PROVIDER_ID) checkClaudeUsage(_ctx);
  });

  pi.on("agent_end", async (event, _ctx) => {
    ctx = _ctx;
    aggregatePiUsage(event.messages);
    flushPiUsageRollups("agent_end");
  });

  pi.registerCommand("codex-reset-usages", {
    description: "Redeem one banked Codex usage reset after typed confirmation",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);

      if (!_ctx.hasUI) return;
      if (state.activeProvider === CLAUDE_BRIDGE_PROVIDER_ID) {
        _ctx.ui.notify("Codex resets apply to Codex models only. Select a Codex model first.", "info");
        return;
      }
      if (resetInFlight) {
        _ctx.ui.notify("A Codex reset check is already in progress.", "warning");
        return;
      }

      resetInFlight = true;
      try {
        const providerId = state.activeProvider as OAuthProviderId;
        const auth = await getFreshCodexAccess(providerId);
        if (!auth.access) {
          _ctx.ui.notify(auth.error ?? "missing Codex access token", "error");
          return;
        }

        const data = await fetchCodexUsage(auth.access);
        state.usage = data;
        state.lastPoll = Date.now();
        updateStatus();

        if (data.error) {
          _ctx.ui.notify(data.error, "error");
          return;
        }

        if (data.resetCreditsAvailable === undefined) {
          _ctx.ui.notify("Could not verify banked Codex resets; no reset was attempted.", "error");
          return;
        }

        if (data.resetCreditsAvailable <= 0) {
          pendingResetRedeemRequestId = undefined;
          _ctx.ui.notify("No banked Codex resets are available.", "info");
          return;
        }

        const confirmed = await confirmUsageReset(_ctx, data, providerId);
        if (!confirmed) {
          _ctx.ui.notify("Codex reset cancelled. No reset was attempted.", "info");
          return;
        }

        const redeemRequestId = pendingResetRedeemRequestId ?? createResetRedeemRequestId();
        pendingResetRedeemRequestId = redeemRequestId;
        const result = await consumeCodexResetCredit(auth.access, redeemRequestId);
        pendingResetRedeemRequestId = undefined;
        _ctx.ui.notify(formatResetConsumeResult(result), result.outcome === "reset" || result.outcome === "already_redeemed" ? "info" : "warning");
        await poll("usage_reset", true);
      } catch (error) {
        const retryHint = pendingResetRedeemRequestId
          ? " No automatic retry was made; run /codex-reset-usages again to retry the same redeem request after checking usage."
          : " No reset was attempted.";
        _ctx.ui.notify(`${toErrorMessage(error)}${retryHint}`, "error");
      } finally {
        resetInFlight = false;
      }
    },
  });

  pi.registerCommand("usage", {
    description: "Show Codex or Claude usage bars",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);

      if (!_ctx.hasUI) return;

      await _ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let data: UsageData | null = state.usage;
          let loading = true;

          const renderSimpleBar = (
            label: string,
            pct: number,
            resetText?: string,
            resetAfterSeconds?: number,
            windowMinutes?: number,
            fallbackWindowMinutes = 0,
            width = 28,
          ): string => {
            const value = clampPercent(pct);
            const filled = Math.round((value / 100) * width);
            const color = colorForPercent(value);

            let allowanceFilled = 0;
            if (resetAfterSeconds && fallbackWindowMinutes > 0) {
              const windowSeconds = (windowMinutes ?? fallbackWindowMinutes) * 60;
              if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
                const elapsedPercent = clampPercent(((windowSeconds - resetAfterSeconds) / windowSeconds) * 100);
                allowanceFilled = Math.round((elapsedPercent / 100) * width);
              }
            }

            let bar = "";
            const overboard = allowanceFilled > 0 && filled > allowanceFilled;
            for (let i = 0; i < width; i++) {
              if (i < filled) {
                bar += overboard && i >= allowanceFilled ? theme.fg("error", "█") : theme.fg(color, "█");
              } else if (i < allowanceFilled) bar += theme.fg("borderMuted", "░");
              else bar += theme.fg("dim", "·");
            }

            const reset = resetText ? theme.fg("dim", `  resets in ${resetText}`) : "";
            return `${theme.fg("muted", label.padEnd(8))} ${bar} ${theme.fg(color, `${value}%`.padStart(4))}${reset}`;
          };

          const fitLine = (line: string, width: number): string =>
            truncateToWidth(line, Math.max(0, width), "");

          const providerId = state.activeProvider;
          fetchUsage(providerId, true)
            .then((usage) => {
              data = usage;
              if (state.activeProvider === providerId) {
                state.usage = usage;
                state.lastPoll = Date.now();
                updateStatus();
              }
            })
            .catch((error) => {
              data = { session: 0, weekly: 0, error: toErrorMessage(error) };
            })
            .finally(() => {
              loading = false;
              tui.requestRender();
            });

          return {
            render(width: number) {
              const separator = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
              const title = fitLine(theme.bold(`${providerDisplayName(providerId)} usage`), width);
              if (loading && !data) return [separator, title, fitLine(theme.fg("dim", "Fetching usage…"), width), separator];
              if (!data) return [separator, title, fitLine(theme.fg("error", "No usage data"), width), separator];
              if (data.error) return [separator, title, fitLine(theme.fg("error", data.error), width), separator];
              const lines = [
                separator,
                title,
              ];
              lines.push(data.session === undefined
                ? fitLine(`${theme.fg("muted", "Session".padEnd(8))} ${theme.fg("dim", "unavailable")}`, width)
                : fitLine(renderSimpleBar("Session", data.session, data.sessionResetsIn, data.sessionResetAfterSeconds, data.sessionWindowMinutes, 300), width));
              lines.push(data.weekly === undefined
                ? fitLine(`${theme.fg("muted", "Weekly".padEnd(8))} ${theme.fg("dim", "unavailable")}`, width)
                : fitLine(renderSimpleBar("Weekly", data.weekly, data.weeklyResetsIn, data.weeklyResetAfterSeconds, data.weeklyWindowMinutes, 7 * 24 * 60), width));
              // Banked resets exist only for Codex.
              if (providerId !== CLAUDE_BRIDGE_PROVIDER_ID) {
                lines.push(fitLine(`${theme.fg("muted", "RESETS".padEnd(8))} ${data.resetCreditsAvailable === undefined ? theme.fg("dim", "unknown") : theme.fg(data.resetCreditsAvailable > 0 ? "success" : "dim", String(data.resetCreditsAvailable))}${data.resetCreditsExpireText ? theme.fg("dim", `  expires ${data.resetCreditsExpireText}`) : ""}`, width));
              }
              lines.push(separator);
              return lines;
            },
            invalidate() {},
            handleInput(keyData: string) {
              if (keyData.includes("\x1b") || keyData === "escape" || keyData === "q" || keyData === "\x03") done();
            },
          };
      });
    },
  });
}
