import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { ProjectInfo } from "./types.js";

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function hashPath(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function parseGitFile(gitFilePath: string): string | null {
  const content = readText(gitFilePath);
  if (!content) return null;
  const match = /^gitdir:\s*(.+)$/im.exec(content);
  if (!match) return null;
  return resolve(dirname(gitFilePath), match[1]!.trim());
}

function findGitMarker(startDir: string): { rootDir: string; markerPath: string } | null {
  let current = tryRealpath(startDir);

  while (true) {
    const markerPath = join(current, ".git");
    if (existsSync(markerPath)) return { rootDir: current, markerPath };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readBranch(gitDir: string): string | undefined {
  const head = readText(join(gitDir, "HEAD"));
  if (!head) return undefined;
  if (head.startsWith("ref:")) {
    const ref = head.slice(4).trim();
    if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
    return ref;
  }
  return head.slice(0, 12);
}

export function detectProjectInfo(cwd: string): ProjectInfo {
  const marker = findGitMarker(cwd);
  let rootDir = tryRealpath(cwd);
  let scopePath = rootDir;
  let scopeKind: "git" | "cwd" = "cwd";
  let gitDir: string | undefined;
  let gitCommonDir: string | undefined;
  let branch: string | undefined;

  if (marker) {
    rootDir = marker.rootDir;
    scopeKind = "git";

    try {
      const stat = lstatSync(marker.markerPath);
      if (stat.isDirectory()) {
        gitDir = tryRealpath(marker.markerPath);
      } else {
        gitDir = parseGitFile(marker.markerPath) ?? undefined;
      }
    } catch {
      gitDir = undefined;
    }

    if (gitDir) {
      const commonDirRaw = readText(join(gitDir, "commondir"));
      gitCommonDir = commonDirRaw ? tryRealpath(resolve(gitDir, commonDirRaw)) : gitDir;
      scopePath = gitCommonDir;
      branch = readBranch(gitDir);
    } else {
      scopePath = rootDir;
    }
  }

  const label = basename(rootDir) || basename(cwd) || "project";
  const key = `${slugify(label)}-${hashPath(scopePath.toLowerCase())}`;
  const projectDir = join(homedir(), ".pi", "agent", "messenger", "projects", key);

  return {
    key,
    label,
    rootDir,
    scopePath,
    scopeKind,
    branch,
    gitDir,
    gitCommonDir,
    projectDir,
  };
}
