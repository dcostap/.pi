import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import titlebarSpinner from "../titlebar-spinner.ts";

function load() {
  const handlers = new Map<string, Function>();
  titlebarSpinner({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    getSessionName() { return "small fix"; },
  } as any);
  return handlers;
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

// A worktree lookup can still run Git in the folder, so retry until it ends.
async function removeTree(path: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test("the title uses the active directory, not the process directory", async () => {
  const handlers = load();
  const titles: string[] = [];
  const ctx = {
    cwd: join(tmpdir(), "first-worktree"),
    ui: { setTitle(title: string) { titles.push(title); } },
  };
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

test("a session in a linked worktree leads its title with the worktree name", async () => {
  const root = mkdtempSync(join(tmpdir(), "titlebar-spinner-"));
  const handlers = load();
  const titles: string[] = [];
  const ctx = {
    cwd: join(root, "task-tree"),
    ui: { setTitle(title: string) { titles.push(title); } },
  };
  try {
    const main = join(root, "main");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main", main);
    git("-C", main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", main, "worktree", "add", "-q", "-b", "task", ctx.cwd);

    await handlers.get("session_start")!({}, ctx);
    await waitFor(() => titles.at(-1) === "wt:task-tree π - small fix");
    expect(titles.at(-1)).toBe("wt:task-tree π - small fix");

    await handlers.get("agent_start")!({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(titles.at(-1)).toMatch(/^wt:task-tree \S \[\d+ s\] π - small fix$/);

    ctx.cwd = join(main);
    await handlers.get("agent_end")!({}, ctx);
    expect(titles.at(-1)).toBe("π - small fix - main");
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    await removeTree(root);
  }
});
