import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_USAGE_INTERVAL_MS as HOUR, sharedClaudeUsage, readUsageSnapshot } from "./claude-usage-cache";

async function temporary(run: (file: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-test-"));
  try { await run(path.join(dir, "usage.json")); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("automatic refreshes share a rolling one-hour cooldown", () => temporary(async (file) => {
  let now = 100;
  let calls = 0;
  const fetch = async () => ({ session: ++calls });
  expect(await sharedClaudeUsage(file, fetch, false, () => now)).toEqual({ session: 1 });
  now += HOUR - 1;
  expect(await sharedClaudeUsage(file, fetch, false, () => now)).toEqual({ session: 1 });
  now++;
  expect(await sharedClaudeUsage(file, fetch, false, () => now)).toEqual({ session: 2 });
}));

test("manual refresh always fetches and restarts the automatic cooldown", () => temporary(async (file) => {
  let now = 100;
  let calls = 0;
  const fetch = async () => ++calls;
  await sharedClaudeUsage(file, fetch, false, () => now);
  now += HOUR / 2;
  expect(await sharedClaudeUsage(file, fetch, true, () => now)).toBe(2);
  now += HOUR / 2;
  expect(await sharedClaudeUsage(file, fetch, false, () => now)).toBe(2);
  expect(calls).toBe(2);
}));

test("100 concurrent automatic refreshes send one request", () => temporary(async (file) => {
  let calls = 0;
  await Promise.all(Array.from({ length: 100 }, () => sharedClaudeUsage(file, async () => {
    calls++;
    await Bun.sleep(20);
    return { session: 42 };
  })));
  expect(calls).toBe(1);
  expect(readUsageSnapshot(file)?.data).toEqual({ session: 42 });
}));

test("errors also start the cooldown and release the lock", () => temporary(async (file) => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error("offline"); };
  await expect(sharedClaudeUsage(file, fetch)).rejects.toThrow("offline");
  expect(await sharedClaudeUsage(file, fetch)).toBeUndefined();
  expect(calls).toBe(1);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
}));

test("HTTP errors are shared without automatic retries", () => temporary(async (file) => {
  let calls = 0;
  const fetch = async () => { calls++; return { error: "HTTP 429" }; };
  await sharedClaudeUsage(file, fetch);
  expect(await sharedClaudeUsage(file, fetch)).toEqual({ error: "HTTP 429" });
  expect(calls).toBe(1);
}));

test("independent processes share the lock and cooldown", () => temporary(async (file) => {
  const module = fileURLToPath(new URL("./claude-usage-cache.ts", import.meta.url));
  const script = `import { sharedClaudeUsage } from ${JSON.stringify(module)};
    import { appendFileSync } from 'node:fs';
    await sharedClaudeUsage(${JSON.stringify(file)}, async () => {
      appendFileSync(${JSON.stringify(file + ".calls")}, 'request\\n');
      await Bun.sleep(50);
      return { session: 42 };
    });`;
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" }));
  for (const child of children) {
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  }
  expect(fs.readFileSync(file + ".calls", "utf8")).toBe("request\n");
}));
