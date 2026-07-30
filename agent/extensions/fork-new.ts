import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

interface ListedSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  parentSessionPath?: string;
}

interface MutableSessionManager {
  setSessionFile(sessionFile: string): void;
  branch(entryId: string): void;
  resetLeaf(): void;
}

function canonicalPath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveParentPath(parentPath: string, childPath: string): string {
  return isAbsolute(parentPath) ? parentPath : resolve(dirname(childPath), parentPath);
}

function sessionLabel(session: ListedSession): string {
  const name = session.name?.trim();
  if (name) return name;

  const firstMessage = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (firstMessage && firstMessage !== "(no messages)") {
    return firstMessage.length > 60 ? `${firstMessage.slice(0, 57)}...` : firstMessage;
  }

  return session.cwd || session.path;
}

function findSessionById(sessions: ListedSession[], query: string): ListedSession {
  const exactMatches = sessions.filter((session) => session.id === query);
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) {
    throw new Error(`Session ID "${query}" is not unique`);
  }

  const normalizedQuery = query.toLowerCase();
  const prefixMatches = sessions.filter((session) => session.id.toLowerCase().startsWith(normalizedQuery));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches
      .slice(0, 5)
      .map((session) => session.id)
      .join(", ");
    const suffix = prefixMatches.length > 5 ? ", ..." : "";
    throw new Error(`Session ID prefix "${query}" is ambiguous: ${candidates}${suffix}`);
  }

  // The startup family view shows a short suffix of each ID. Also accept a
  // unique fragment so the displayed suffix can be used directly.
  const fragmentMatches = sessions.filter((session) => session.id.toLowerCase().includes(normalizedQuery));
  if (fragmentMatches.length === 1) return fragmentMatches[0]!;
  if (fragmentMatches.length === 0) {
    throw new Error(`No persisted session matches "${query}"`);
  }

  const candidates = fragmentMatches
    .slice(0, 5)
    .map((session) => session.id)
    .join(", ");
  const suffix = fragmentMatches.length > 5 ? ", ..." : "";
  throw new Error(`Session ID fragment "${query}" is ambiguous: ${candidates}${suffix}`);
}

/**
 * Follow the prospective parent's ancestry. Reparenting to a descendant of
 * the current session would create a cycle in the session-family graph.
 */
function validateParentAncestry(
  target: ListedSession,
  currentPath: string,
  sessionsByPath: Map<string, ListedSession>,
): void {
  const currentKey = canonicalPath(currentPath);
  const visited = new Set<string>();
  let childPath = target.path;

  for (;;) {
    const childKey = canonicalPath(childPath);
    if (childKey === currentKey) {
      throw new Error("Cannot make a session its own ancestor (the target is a descendant of the current session)");
    }
    if (visited.has(childKey)) {
      throw new Error("Cannot reparent: the target session already has a cyclic ancestry");
    }
    visited.add(childKey);

    const session = sessionsByPath.get(childKey);
    const parentPath = session?.parentSessionPath;
    if (!parentPath) return;

    childPath = resolveParentPath(parentPath, childPath);
  }
}

function writeSessionWithParent(
  sessionFile: string,
  header: SessionHeader,
  entries: SessionEntry[],
  parentSession: string,
): void {
  const newHeader: SessionHeader = { ...header, parentSession };
  const content = [newHeader, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const temporaryPath = `${sessionFile}.parent-tmp-${process.pid}-${Date.now()}-${randomUUID()}`;

  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, sessionFile);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was normally removed by renameSync().
    }
  }
}

function reloadSessionManager(
  sessionManager: SessionManager,
  sessionFile: string,
  previousLeafId: string | null,
): void {
  const mutable = sessionManager as unknown as MutableSessionManager;
  mutable.setSessionFile(sessionFile);

  // setSessionFile() normally positions the manager at the file's last entry.
  // Restore a /tree selection that was active before the header-only rewrite.
  if (previousLeafId === null) {
    mutable.resetLeaf();
  } else {
    mutable.branch(previousLeafId);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-new", {
    description: "Start a fresh session linked to the current session",
    handler: async (_args, ctx) => {
      const parentSession = ctx.sessionManager.getSessionFile();

      const result = await ctx.newSession({
        parentSession,
        withSession: async (newCtx) => {
          newCtx.ui.notify(
            parentSession
              ? "Started a fresh session linked to its parent"
              : "Started a fresh session (the previous session was not persisted)",
            "info",
          );
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
      }
    },
  });

  pi.registerCommand("parent", {
    description: "Set the current session's parent session",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot set a parent for an ephemeral session", "error");
        return;
      }

      let query = args.trim();
      if (!query) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /parent <session-id-or-unique-fragment>", "error");
          return;
        }

        const entered = await ctx.ui.input(
          "Parent session ID or unique fragment",
          "Enter a session ID, prefix, or displayed suffix",
        );
        if (entered === undefined) {
          ctx.ui.notify("Parent selection cancelled", "info");
          return;
        }
        query = entered.trim();
      }

      if (!query) {
        ctx.ui.notify("A parent session ID or unique fragment is required", "error");
        return;
      }

      await ctx.waitForIdle();

      let sessions: ListedSession[];
      try {
        sessions = await SessionManager.listAll();
      } catch (error) {
        ctx.ui.notify(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      let target: ListedSession;
      try {
        target = findSessionById(sessions, query);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const currentPath = canonicalPath(sessionFile);
      const targetPath = resolve(target.path);
      if (canonicalPath(targetPath) === currentPath) {
        ctx.ui.notify("A session cannot be its own parent", "error");
        return;
      }
      if (!existsSync(targetPath)) {
        ctx.ui.notify("The selected session no longer exists", "error");
        return;
      }

      const sessionsByPath = new Map(
        sessions.map((session) => [canonicalPath(session.path), session]),
      );
      try {
        validateParentAncestry(target, sessionFile, sessionsByPath);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const header = ctx.sessionManager.getHeader();
      if (!header) {
        ctx.ui.notify("The current session has no valid session header", "error");
        return;
      }
      if (header.parentSession && canonicalPath(header.parentSession) === canonicalPath(targetPath)) {
        ctx.ui.notify(`Parent already set to ${target.id}`, "info");
        return;
      }

      const previousLeafId = ctx.sessionManager.getLeafId();
      try {
        writeSessionWithParent(
          sessionFile,
          header,
          ctx.sessionManager.getEntries(),
          targetPath,
        );
        reloadSessionManager(
          ctx.sessionManager as unknown as SessionManager,
          sessionFile,
          previousLeafId,
        );
      } catch (error) {
        ctx.ui.notify(`Could not set parent session: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      ctx.ui.notify(`Parent session set to ${target.id} (${sessionLabel(target)})`, "info");
    },
  });
}
