import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import chromeCdpExtension, { __testing } from "./index.ts";

describe("Chrome CDP working directory", () => {
  test("script paths follow each invocation, not the process directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cdp-cwd-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "script.js"), "'first checkout'");
      writeFileSync(join(second, "script.js"), "'second checkout'");
      const args = { action: "script" as const, expressionPath: "script.js", outputPath: "result.txt" };

      const firstCall = __testing.resolveLocalPaths(args, first);
      const secondCall = __testing.resolveLocalPaths(args, second);
      expect(__testing.readExpressionFile(firstCall.expressionPath!)).toContain("'first checkout'");
      expect(__testing.readExpressionFile(secondCall.expressionPath!)).toContain("'second checkout'");
      expect(firstCall.outputPath).toBe(join(first, "result.txt"));
      expect(secondCall.outputPath).toBe(join(second, "result.txt"));
      expect(args.expressionPath).toBe("script.js");
      expect(args.outputPath).toBe("result.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("absolute paths stay explicit; omitted paths retain automatic output handling", () => {
    const target = resolve(tmpdir(), "explicit-cdp-file");
    const args = __testing.resolveLocalPaths({ action: "eval", expressionPath: target, outputPath: target }, tmpdir());
    expect(args.expressionPath).toBe(target);
    expect(args.outputPath).toBe(target);
    const omitted = __testing.resolveLocalPaths({ action: "shot" }, tmpdir());
    expect(omitted.expressionPath).toBeUndefined();
    expect(omitted.outputPath).toBeUndefined();
  });

  test("the registered tool writes downloads only into the invocation directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cdp-download-cwd-"));
    const outputPath = `pi-cdp-cwd-${randomUUID()}.txt`;
    let tool: any;
    chromeCdpExtension({ on() {}, registerTool(value: any) { tool = value; } } as any);
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      const ctx = { cwd: first };
      const pending = tool.execute("first", {
        action: "download", url: "data:text/plain,first", outputPath,
      }, undefined, undefined, ctx);
      // A running action keeps its original paths, even if a later call uses another directory.
      ctx.cwd = second;
      await pending;
      await tool.execute("second", {
        action: "download", url: "data:text/plain,second", outputPath,
      }, undefined, undefined, ctx);

      expect(readFileSync(join(first, outputPath), "utf8")).toBe("first");
      expect(readFileSync(join(second, outputPath), "utf8")).toBe("second");
      expect(existsSync(resolve(outputPath))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      // Remove a misplaced test artifact if the regression returns.
      rmSync(resolve(outputPath), { force: true });
    }
  });
});
