import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import titlebarSpinner from "../titlebar-spinner.ts";

test("the title uses the active directory, not the process directory", async () => {
  const handlers = new Map<string, Function>();
  const titles: string[] = [];
  const ctx = {
    cwd: join(tmpdir(), "first-worktree"),
    ui: { setTitle(title: string) { titles.push(title); } },
  };
  titlebarSpinner({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    getSessionName() { return "small fix"; },
  } as any);
  try {
    await handlers.get("agent_start")!({}, ctx);
    expect(titles.at(-1)).toBe("π - small fix - first-worktree");
    ctx.cwd = join(tmpdir(), "second-worktree");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(titles.at(-1)).toContain("π - small fix - second-worktree");
    await handlers.get("agent_end")!({}, ctx);
    expect(titles.at(-1)).toBe("π - small fix - second-worktree");
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});
