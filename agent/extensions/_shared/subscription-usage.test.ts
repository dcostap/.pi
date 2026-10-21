import { test, expect, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
