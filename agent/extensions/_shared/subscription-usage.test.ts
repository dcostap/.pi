import { test, expect, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subscription-test-"));
mock.module("@earendil-works/pi-coding-agent", () => ({ DynamicBorder: class {}, getAgentDir: () => dir }));
mock.module("@earendil-works/pi-tui", () => ({
  Container: class {}, Input: class {}, Spacer: class {}, Text: class {},
  getKeybindings: () => ({}), truncateToWidth: (text: string) => text,
}));
const { default: register } = await import("../subscription-usage.ts");

test("Claude stays idle without requests; inference shares cooldown; manual refresh sends exactly one request", async () => {
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const timers: Array<() => void> = [];
  const sessions: any[] = [];
  let requests = 0;
  process.env.CLAUDE_CONFIG_DIR = dir;
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test" } }));
  globalThis.setInterval = ((callback: () => void) => { timers.push(callback); return 1; }) as any;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }));
  }) as any;
  try {
    for (let i = 0; i < 100; i++) {
      const handlers = new Map<string, any>();
      const commands = new Map<string, any>();
      const ctx = {
        model: { provider: "claude-bridge", id: "claude-opus" },
        hasUI: true,
        ui: {
          setStatus() {},
          async custom(create: any) {
            let rendered: () => void;
            const finished = new Promise<void>((resolve) => { rendered = resolve; });
            create({ requestRender: () => rendered() }, {}, {}, () => {});
            await finished;
          },
        },
      };
      register({ on: (name: string, handler: any) => handlers.set(name, handler),
        registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
      sessions.push({ handlers, commands, ctx });
      await handlers.get("session_start")({}, ctx);
      await handlers.get("model_select")({ model: ctx.model }, ctx);
    }
    timers.forEach((tick) => tick());
    await Bun.sleep(20);
    expect(requests).toBe(0);

    await Promise.all(sessions.map(({ handlers, ctx }) => handlers.get("turn_start")({}, ctx)));
    await Bun.sleep(50);
    expect(requests).toBe(1);
    timers.forEach((tick) => tick());
    expect(requests).toBe(1);

    const { commands, ctx } = sessions[0];
    await commands.get("usage").handler("", ctx);
    expect(requests).toBe(2);
    await commands.get("usage").handler("", ctx);
    expect(requests).toBe(3);
  } finally {
    for (const { handlers, ctx } of sessions) await handlers.get("session_shutdown")({}, ctx);
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function codexFixture() {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "test-token" } }));
  const handlers = new Map<string, any>();
  const statuses: Array<string | undefined> = [];
  const ctx = {
    model: { provider: "openai-codex", id: "test" },
    hasUI: true,
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-token" } }) },
    ui: { theme: { fg: (_: string, text: string) => text }, setStatus: (_: string, text?: string) => statuses.push(text) },
  };
  register({ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand() {} } as any);
  return { handlers, statuses, ctx };
}

test("startup shows cached usage before the background request completes", async () => {
  const originalFetch = globalThis.fetch;
  const { handlers, statuses, ctx } = codexFixture();
  const cache = path.join(dir, "openai-codex-usage-cache.json");
  fs.writeFileSync(cache, JSON.stringify({
    attemptedAt: Date.now(),
    data: {
      identity: createHash("sha256").update("test-token").digest("hex"),
      usage: { session: 85, weekly: 20, sessionResetAt: Date.now() + 3600000, sessionResetsIn: "old countdown" },
    },
  }));
  let finish!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as any;
  try {
    expect(handlers.get("session_start")({}, ctx)).toBeUndefined();
    expect(statuses.at(-1)).toContain("85%");
    expect(statuses.at(-1)).not.toContain("old countdown");
    await Bun.sleep(5);
    finish(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 91 } }, rate_limit_reset_credits: { available_count: 0 } })));
    await Bun.sleep(20);
    expect(statuses.at(-1)).toContain("91%");
    const saved = fs.readFileSync(cache, "utf8");
    expect(saved).not.toContain("test-token");
    expect(JSON.parse(saved).data.usage.session).toBe(91);
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown cancels a pending startup request without restoring the footer", async () => {
  const originalFetch = globalThis.fetch;
  const { handlers, statuses, ctx } = codexFixture();
  let aborted = false;
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true });
  })) as any;
  try {
    handlers.get("session_start")({}, ctx);
    await Bun.sleep(5);
    await handlers.get("session_shutdown")({}, ctx);
    const count = statuses.length;
    await Bun.sleep(20);
    expect(aborted).toBe(true);
    expect(statuses.length).toBe(count);
    expect(statuses.at(-1)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "openai-codex-usage-cache.json"))).toBe(false);
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startup ignores another account's cache and expired quota windows", async () => {
  const originalFetch = globalThis.fetch;
  const { handlers, statuses, ctx } = codexFixture();
  const cache = path.join(dir, "openai-codex-usage-cache.json");
  const snapshot = {
    attemptedAt: Date.now(),
    data: { identity: "another-account", usage: { session: 99, sessionResetAt: Date.now() - 1000 } },
  };
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as any;
  try {
    fs.writeFileSync(cache, JSON.stringify(snapshot));
    handlers.get("session_start")({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
    await Bun.sleep(5);
    await handlers.get("session_shutdown")({}, ctx);
    await Bun.sleep(5);
    snapshot.data.identity = createHash("sha256").update("test-token").digest("hex");
    fs.writeFileSync(cache, JSON.stringify(snapshot));
    handlers.get("session_start")({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
    await Bun.sleep(5);
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
