/**
 * Better Codex Support for pi.
 *
 * Codex-only usage indicator plus Codex fast mode.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const LOG_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const STATUS_KEY = "better-codex-support-usage";
const FAST_WIDGET_KEY = "better-codex-support-fast";
const SHOW_THRESHOLD = 80;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const AUTH_FILE = path.join(AGENT_DIR, "auth.json");
const OBSERVATIONS_FILE = path.join(AGENT_DIR, "codex-usage-observations.jsonl");
const CODEX_FAST_CONFIG_FILE = path.join(AGENT_DIR, "extensions", "codex-fast-mode.json");
const CODEX_FAST_FLAG = "codex-fast";
const CODEX_FAST_SERVICE_TIER = "priority";
const DEFAULT_CODEX_FAST_SUPPORTED_MODELS = ["gpt-5.4", "gpt-5.5"];

type ProviderKey = "codex";
type OAuthProviderId = "openai-codex";

interface AuthData {
  "openai-codex"?: { access?: string; refresh?: string; expires?: number };
}

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
  session: number;
  weekly: number;
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
}

interface OAuthApiKeyResult {
  newCredentials: Record<string, any>;
  apiKey: string;
}

type OAuthApiKeyResolver = (
  providerId: OAuthProviderId,
  credentials: Record<string, Record<string, any>>,
) => Promise<OAuthApiKeyResult | null>;

interface FreshAuthResult {
  auth: AuthData | null;
  changed: boolean;
  refreshErrors: Partial<Record<OAuthProviderId, string>>;
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

interface CodexFastConfig {
  persistState: boolean;
  desiredActive: boolean;
  supportedModels: string[];
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

function normalizeCodexFastModel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const prefix = "openai-codex/";
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || undefined;
  if (trimmed.includes("/")) return undefined;
  return trimmed;
}

function readCodexFastConfig(configFile = CODEX_FAST_CONFIG_FILE): CodexFastConfig {
  let raw: Record<string, any> = {};
  try {
    raw = asObject(JSON.parse(fs.readFileSync(configFile, "utf-8"))) ?? {};
  } catch {
    raw = {};
  }

  const supportedModels = Array.isArray(raw.supportedModels)
    ? raw.supportedModels
        .filter((entry: unknown): entry is string => typeof entry === "string")
        .map(normalizeCodexFastModel)
        .filter((entry): entry is string => entry !== undefined)
    : DEFAULT_CODEX_FAST_SUPPORTED_MODELS;

  return {
    persistState: typeof raw.persistState === "boolean" ? raw.persistState : true,
    desiredActive: typeof raw.desiredActive === "boolean" ? raw.desiredActive : false,
    supportedModels: Array.from(new Set(supportedModels)),
  };
}

function writeCodexFastConfig(config: CodexFastConfig, configFile = CODEX_FAST_CONFIG_FILE): boolean {
  try {
    const dir = path.dirname(configFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${configFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, configFile);
    return true;
  } catch {
    return false;
  }
}

function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function codexFastModelList(models: string[]): string {
  return models.length > 0 ? models.map((model) => `openai-codex/${model}`).join(", ") : "none configured";
}

function supportsCodexFast(ctx: ExtensionContext, config: CodexFastConfig): boolean {
  return ctx.model?.provider === "openai-codex" && config.supportedModels.includes(ctx.model.id);
}

function codexFastStateText(ctx: ExtensionContext, desiredActive: boolean, active: boolean, config: CodexFastConfig): string {
  const model = currentModelKey(ctx);
  if (active) return `Codex fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Codex fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${codexFastModelList(config.supportedModels)}.`;
  }
  return `Codex fast mode is off. Current model: ${model}.`;
}


async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<JsonRequestResult> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
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

function writeAuth(auth: AuthData, authFile = AUTH_FILE): boolean {
  try {
    const dir = path.dirname(authFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${authFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2));
    fs.renameSync(tmpPath, authFile);
    return true;
  } catch {
    return false;
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

let cachedOAuthResolver: OAuthApiKeyResolver | null = null;

async function getDefaultOAuthResolver(): Promise<OAuthApiKeyResolver> {
  if (cachedOAuthResolver) return cachedOAuthResolver;

  const mod = await import("@earendil-works/pi-ai/oauth");
  if (typeof (mod as any).getOAuthApiKey !== "function") {
    throw new Error("oauth resolver unavailable");
  }

  cachedOAuthResolver = (providerId, credentials) =>
    (mod as any).getOAuthApiKey(providerId, credentials) as Promise<OAuthApiKeyResult | null>;

  return cachedOAuthResolver;
}

function isCredentialExpired(creds: { expires?: number } | undefined, nowMs: number): boolean {
  if (!creds) return false;
  if (typeof creds.expires !== "number") return false;
  return nowMs + TOKEN_REFRESH_SKEW_MS >= creds.expires;
}

async function ensureFreshCodexAuth(authFile = AUTH_FILE): Promise<FreshAuthResult> {
  const auth = readAuth(authFile);
  if (!auth) {
    return { auth: null, changed: false, refreshErrors: {} };
  }

  const providerId: OAuthProviderId = "openai-codex";
  const nowMs = Date.now();
  const nextAuth: AuthData = { ...auth };
  const refreshErrors: Partial<Record<OAuthProviderId, string>> = {};
  let changed = false;

  const creds = nextAuth[providerId];
  if (creds?.refresh) {
    const needsRefresh = !creds.access || isCredentialExpired(creds, nowMs);

    if (needsRefresh) {
      try {
        const resolver = await getDefaultOAuthResolver();
        const resolved = await resolver(providerId, nextAuth as any);
        if (!resolved?.newCredentials) {
          refreshErrors[providerId] = "missing OAuth credentials";
        } else {
          nextAuth[providerId] = {
            ...(nextAuth[providerId] ?? {}),
            ...resolved.newCredentials,
          };
          changed = true;
        }
      } catch (error) {
        refreshErrors[providerId] = toErrorMessage(error);
      }
    }
  }

  if (changed) {
    writeAuth(nextAuth, authFile);
  }

  return { auth: nextAuth, changed, refreshErrors };
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

async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const headers = codexUsageHeaders(token);
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const primary = result.data?.rate_limit?.primary_window;
  const secondary = result.data?.rate_limit?.secondary_window;
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
    session: readPercentCandidate(primary?.used_percent) ?? 0,
    weekly: readPercentCandidate(secondary?.used_percent) ?? 0,
    resetCreditsAvailable,
    resetCredits,
    resetCreditsExpireText: formatResetCreditExpiries(resetCredits),
    sessionResetsIn:
      typeof primary?.reset_after_seconds === "number" ? formatDuration(primary.reset_after_seconds) : undefined,
    weeklyResetsIn:
      typeof secondary?.reset_after_seconds === "number" ? formatResetAt(secondary.reset_after_seconds) : undefined,
    sessionResetAfterSeconds:
      typeof primary?.reset_after_seconds === "number" ? primary.reset_after_seconds : undefined,
    weeklyResetAfterSeconds:
      typeof secondary?.reset_after_seconds === "number" ? secondary.reset_after_seconds : undefined,
    sessionResetAt: resetAtMs(primary),
    weeklyResetAt: resetAtMs(secondary),
    sessionWindowMinutes: typeof primary?.window_minutes === "number" ? primary.window_minutes : undefined,
    weeklyWindowMinutes: typeof secondary?.window_minutes === "number" ? secondary.window_minutes : undefined,
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

function detectProvider(model: { provider?: string; id?: string; name?: string; api?: string } | undefined | null): ProviderKey | null {
  if (!model) return null;
  const provider = (model.provider || "").toLowerCase();
  if (provider === "openai-codex") return "codex";
  return null;
}

function canShowForProvider(active: ProviderKey | null, auth: AuthData | null): boolean {
  if (!active || !auth) return false;
  return !!(auth["openai-codex"]?.access || auth["openai-codex"]?.refresh);
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
  return data.session > SHOW_THRESHOLD || data.weekly > SHOW_THRESHOLD;
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
  private activeProvider: ProviderKey | null;
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
    activeProvider: ProviderKey | null,
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
        name: "Codex",
        provider: "codex",
        data: result,
        isActive: this.activeProvider === "codex",
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
      const session = clampPercent(item.data.session);
      const weekly = clampPercent(item.data.weekly);

      const sessionReset = item.data.sessionResetsIn
        ? t.fg("dim", `  resets in ${item.data.sessionResetsIn}`)
        : "";
      const weeklyReset = item.data.weeklyResetsIn
        ? t.fg("dim", `  resets in ${item.data.weeklyResetsIn}`)
        : "";

      this.listContainer.addChild(
        new Text(
          indent +
            t.fg("muted", "Session  ") +
            this.renderBar(session) +
            " " +
            t.fg(colorForPercent(session), `${session}%`.padStart(4)) +
            sessionReset,
          0,
          0,
        ),
      );

      this.listContainer.addChild(
        new Text(
          indent +
            t.fg("muted", "Weekly   ") +
            this.renderBar(weekly) +
            " " +
            t.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) +
            weeklyReset,
          0,
          0,
        ),
      );

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

      if (!(item.data.session > SHOW_THRESHOLD || item.data.weekly > SHOW_THRESHOLD)) {
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
    codex: null as UsageData | null,
    lastPoll: 0,
    activeProvider: null as ProviderKey | null,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollQueued = false;
  let ctx: any = null;
  let lastLoggedSnapshotAt = 0;
  let lastLoggedSnapshotKey: string | null = null;
  let lastRollupFlushAt = 0;
  const rollups = new Map<string, UsageRollup>();
  let fastConfig = readCodexFastConfig();
  let fastDesiredActive = fastConfig.desiredActive;
  let fastActive = false;
  let lastFastInjectedAt: number | undefined;
  let lastFastInjectedModel: string | undefined;
  let resetInFlight = false;
  let pendingResetRedeemRequestId: string | undefined;

  pi.registerFlag(CODEX_FAST_FLAG, {
    description: "Start with Codex fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });

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

  async function getFreshCodexAccess(): Promise<{ access?: string; error?: string }> {
    if (!hasCodexCredentials(readAuth())) return { error: "missing Codex credentials (try /login openai-codex)" };
    const refreshed = await ensureFreshCodexAuth();
    const access = refreshed.auth?.["openai-codex"]?.access;
    if (access) return { access };
    const refreshError = refreshed.refreshErrors["openai-codex"];
    return { error: refreshError ? `auth refresh failed (${refreshError})` : "missing access token (try /login again)" };
  }

  async function confirmUsageReset(_ctx: ExtensionContext, data: UsageData): Promise<boolean> {
    if (!_ctx.hasUI) return false;

    return _ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      let input = "";
      const fitLine = (line: string, width: number): string => truncateToWidth(line, Math.max(0, width), "");
      const renderUsage = () =>
        `Current usage: session ${clampPercent(data.session)}%, weekly ${clampPercent(data.weekly)}%`;
      const renderResets = () => {
        const count = data.resetCreditsAvailable === undefined ? "unknown" : String(data.resetCreditsAvailable);
        return `Banked resets: ${count}${data.resetCreditsExpireText ? ` (expires ${data.resetCreditsExpireText})` : ""}`;
      };

      return {
        render(width: number) {
          const separator = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
          return [
            separator,
            fitLine(theme.bold("Confirm Codex usage reset"), width),
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
    const data = state.codex;

    if (!ctx?.hasUI) return;

    if (!active) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const auth = readAuth();
    if (!canShowForProvider(active, auth)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    if (!shouldRenderFooter(data)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const session = clampPercent(data.session);
    const weekly = clampPercent(data.weekly);

    const sessionReset = data.sessionResetsIn ? theme.fg("dim", ` ⟳ ${data.sessionResetsIn}`) : "";
    const weeklyReset = data.weeklyResetsIn ? theme.fg("dim", ` ⟳ ${data.weeklyResetsIn}`) : "";
    const resetBank = data.resetCreditsAvailable === undefined
      ? ""
      : theme.fg("muted", " RESETS ") +
        theme.fg(data.resetCreditsAvailable > 0 ? "success" : "dim", String(data.resetCreditsAvailable)) +
        (data.resetCreditsExpireText ? theme.fg("dim", ` exp ${data.resetCreditsExpireText}`) : "");

    const status =
      theme.fg("dim", "Codex ") +
      theme.fg("muted", "S ") +
      renderBar(theme, session) +
      " " +
      renderPercent(theme, session) +
      sessionReset +
      theme.fg("muted", " W ") +
      renderBar(theme, weekly) +
      " " +
      renderPercent(theme, weekly) +
      weeklyReset +
      resetBank;

    ctx.ui.setStatus(STATUS_KEY, status);
  }

  function updateProviderFrom(modelLike: any): boolean {
    const previous = state.activeProvider;
    state.activeProvider = detectProvider(modelLike);

    if (previous !== state.activeProvider) {
      if (!state.activeProvider) state.codex = null;
      updateStatus();
      return true;
    }

    return false;
  }

  function applyFastState(_ctx: ExtensionContext): boolean {
    const previous = fastActive;
    fastActive = fastDesiredActive && supportsCodexFast(_ctx, fastConfig);
    return previous !== fastActive;
  }

  function persistFastState(): void {
    if (!fastConfig.persistState) return;
    fastConfig = { ...fastConfig, desiredActive: fastDesiredActive };
    writeCodexFastConfig(fastConfig);
  }

  function updateFastStatus(_ctx: ExtensionContext): void {
    if (!_ctx.hasUI) return;
    _ctx.ui.setStatus("codex-fast-mode", undefined);

    if (fastActive) {
      _ctx.ui.setWidget(
        FAST_WIDGET_KEY,
        [_ctx.ui.theme.fg("success", "⚡ Codex fast mode")],
        { placement: "belowEditor" },
      );
      return;
    }

    if (fastDesiredActive && _ctx.model?.provider === "openai-codex") {
      _ctx.ui.setWidget(
        FAST_WIDGET_KEY,
        [_ctx.ui.theme.fg("success", "⚡ Codex fast pending for this model")],
        { placement: "belowEditor" },
      );
      return;
    }

    _ctx.ui.setWidget(FAST_WIDGET_KEY, undefined);
  }

  function formatFastStatus(_ctx: ExtensionContext): string {
    return [
      codexFastStateText(_ctx, fastDesiredActive, fastActive, fastConfig),
      `Configured service_tier: ${CODEX_FAST_SERVICE_TIER}`,
      `Supported models: ${codexFastModelList(fastConfig.supportedModels)}`,
      `Persist state: ${fastConfig.persistState}`,
      `Last injected: ${lastFastInjectedAt ? `${new Date(lastFastInjectedAt).toLocaleTimeString()} (${lastFastInjectedModel})` : "never"}`,
      `Config: ${CODEX_FAST_CONFIG_FILE}`,
    ].join("\n");
  }

  function setFastDesired(_ctx: ExtensionContext, next: boolean): void {
    fastConfig = readCodexFastConfig();
    fastDesiredActive = next;
    applyFastState(_ctx);
    persistFastState();
    updateFastStatus(_ctx);
    if (!_ctx.hasUI) return;
    _ctx.ui.notify(
      codexFastStateText(_ctx, fastDesiredActive, fastActive, fastConfig),
      fastDesiredActive && !fastActive ? "warning" : "info",
    );
  }

  async function handleFastCommand(args: string, _ctx: ExtensionContext): Promise<void> {
    ctx = _ctx;
    fastConfig = readCodexFastConfig();
    applyFastState(_ctx);
    updateFastStatus(_ctx);

    const arg = args.trim().toLowerCase();
    if (!arg || arg === "toggle") {
      setFastDesired(_ctx, !fastDesiredActive);
      return;
    }
    if (["on", "enable", "enabled", "true", "1"].includes(arg)) {
      setFastDesired(_ctx, true);
      return;
    }
    if (["off", "disable", "disabled", "false", "0"].includes(arg)) {
      setFastDesired(_ctx, false);
      return;
    }
    if (["status", "debug", "?"].includes(arg)) {
      if (_ctx.hasUI) _ctx.ui.notify(formatFastStatus(_ctx), "info");
      return;
    }

    if (_ctx.hasUI) _ctx.ui.notify("Usage: /fast [on|off|status]", "error");
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
    const data = state.codex;
    if (!data || data.error) return false;

    const now = Date.now();
    const key = snapshotKey(data);
    const stale = now - lastLoggedSnapshotAt >= LOG_SNAPSHOT_INTERVAL_MS;
    const changed = key !== lastLoggedSnapshotKey;
    if (!force && !changed && !stale) return false;

    const wrote = appendObservation({
      type: "codex_quota_snapshot",
      timestamp: toIso(now),
      reason: force ? reason : changed ? `${reason}_changed` : `${reason}_stale`,
      provider: "openai-codex",
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
      if (message.provider !== "openai-codex") continue;
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

  function hasCodexCredentials(auth: AuthData | null): boolean {
    return !!(auth?.["openai-codex"]?.access || auth?.["openai-codex"]?.refresh);
  }

  async function runPoll(reason: string, forceLog = false) {
    if (!hasCodexCredentials(readAuth())) {
      state.codex = null;
      state.lastPoll = Date.now();
      updateStatus();
      return;
    }

    const refreshed = await ensureFreshCodexAuth();
    const refreshError = refreshed.refreshErrors["openai-codex"];
    const access = refreshed.auth?.["openai-codex"]?.access;

    state.codex = access
      ? await fetchCodexUsage(access)
      : {
          session: 0,
          weekly: 0,
          error: refreshError ? `auth refresh failed (${refreshError})` : "missing access token (try /login again)",
        };

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
    } while (pollQueued);
  }

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    updateProviderFrom(_ctx.model);

    fastConfig = readCodexFastConfig();
    fastDesiredActive = fastConfig.persistState ? fastConfig.desiredActive : false;
    if (pi.getFlag(CODEX_FAST_FLAG) === true) fastDesiredActive = true;
    applyFastState(_ctx);
    persistFastState();
    updateFastStatus(_ctx);
    if (fastDesiredActive && !fastActive && _ctx.hasUI && _ctx.model?.provider === "openai-codex") {
      _ctx.ui.notify(codexFastStateText(_ctx, fastDesiredActive, fastActive, fastConfig), "warning");
    }

    await poll("session_start", true);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void poll("periodic");
    }, POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    flushPiUsageRollups("session_shutdown", true);

    if (_ctx?.hasUI) {
      _ctx.ui.setStatus(STATUS_KEY, undefined);
      _ctx.ui.setStatus("codex-usage-threshold", undefined);
      _ctx.ui.setStatus("codex-fast-mode", undefined);
      _ctx.ui.setWidget(FAST_WIDGET_KEY, undefined);
    }
  });

  pi.on("turn_start", async (_event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(_ctx.model);
    applyFastState(_ctx);
    updateFastStatus(_ctx);
    if (changed && state.activeProvider === "codex") await poll("turn_start_model_changed", true);
  });

  pi.on("model_select", async (event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(event.model ?? _ctx.model);
    const fastChanged = applyFastState(_ctx);
    updateFastStatus(_ctx);
    if (fastChanged && fastDesiredActive && _ctx.hasUI) {
      _ctx.ui.notify(codexFastStateText(_ctx, fastDesiredActive, fastActive, fastConfig), fastActive ? "info" : "warning");
    }
    if (changed && state.activeProvider === "codex") await poll("model_select", true);
  });

  pi.on("agent_end", async (event, _ctx) => {
    ctx = _ctx;
    aggregatePiUsage(event.messages);
    flushPiUsageRollups("agent_end");
  });

  pi.on("before_provider_request", (event, _ctx) => {
    ctx = _ctx;
    applyFastState(_ctx);
    updateFastStatus(_ctx);
    const payload = asObject(event.payload);
    if (!fastActive || !payload) return;

    lastFastInjectedAt = Date.now();
    lastFastInjectedModel = currentModelKey(_ctx);
    return { ...payload, service_tier: CODEX_FAST_SERVICE_TIER };
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex fast mode",
    handler: handleFastCommand,
  });

  pi.registerCommand("codex-reset-usages", {
    description: "Redeem one banked Codex usage reset after typed confirmation",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);

      if (!_ctx.hasUI) return;
      if (resetInFlight) {
        _ctx.ui.notify("A Codex reset check is already in progress.", "warning");
        return;
      }

      resetInFlight = true;
      try {
        const auth = await getFreshCodexAccess();
        if (!auth.access) {
          _ctx.ui.notify(auth.error ?? "missing Codex access token", "error");
          return;
        }

        const data = await fetchCodexUsage(auth.access);
        state.codex = data;
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

        const confirmed = await confirmUsageReset(_ctx, data);
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
    description: "Show Codex usage bars",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);

      if (!_ctx.hasUI) return;

      try {
        await _ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let data: UsageData | null = state.codex;
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

          ensureFreshCodexAuth()
            .then((refreshed) => {
              const access = refreshed.auth?.["openai-codex"]?.access;
              if (!access) {
                data = {
                  session: 0,
                  weekly: 0,
                  error: refreshed.refreshErrors["openai-codex"]
                    ? `auth refresh failed (${refreshed.refreshErrors["openai-codex"]})`
                    : "missing access token (try /login again)",
                };
                return;
              }
              return fetchCodexUsage(access).then((usage) => {
                data = usage;
              });
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
              if (loading) return [separator, fitLine(theme.fg("dim", "Fetching Codex usage…"), width), separator];
              if (!data) return [separator, fitLine(theme.fg("error", "No usage data"), width), separator];
              if (data.error) return [separator, fitLine(theme.fg("error", data.error), width), separator];
              return [
                separator,
                fitLine(renderSimpleBar("Session", data.session, data.sessionResetsIn, data.sessionResetAfterSeconds, data.sessionWindowMinutes, 300), width),
                fitLine(renderSimpleBar("Weekly", data.weekly, data.weeklyResetsIn, data.weeklyResetAfterSeconds, data.weeklyWindowMinutes, 7 * 24 * 60), width),
                fitLine(`${theme.fg("muted", "RESETS".padEnd(8))} ${data.resetCreditsAvailable === undefined ? theme.fg("dim", "unknown") : theme.fg(data.resetCreditsAvailable > 0 ? "success" : "dim", String(data.resetCreditsAvailable))}${data.resetCreditsExpireText ? theme.fg("dim", `  expires ${data.resetCreditsExpireText}`) : ""}`, width),
                separator,
              ];
            },
            invalidate() {},
            handleInput(keyData: string) {
              if (keyData.includes("\x1b") || keyData === "escape" || keyData === "q" || keyData === "\x03") done();
            },
          };
        });
      } finally {
        await poll("manual", true);
      }
    },
  });
}
