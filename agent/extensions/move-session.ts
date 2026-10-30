/**
 * Session Move Extension
 *
 * Move the current session into another cwd bucket and continue it there, in the same pi process
 *
 * Implementation strategy:
 *  1) Fork the current session file into the target cwd bucket using SessionManager.forkFrom(), keeping the session ID
 *  2) Clear the fork header's parentSession pointer
 *  3) Switch pi to the fork. Pi rebuilds tools, resources, and ctx.cwd for the target directory
 *  4) Trash the old session file
 *
 * The agent uses the move_session tool. The tool queues the same command, which waits for the
 * agent's turn to end, moves the session, and then lets the agent continue in the target.
 *
 * Usage:
 *   /move-session <targetCwd>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
    statSync,
    openSync,
    readSync,
    writeSync,
    closeSync,
    renameSync,
    unlinkSync,
} from "node:fs";
import { Type } from "typebox";

import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "./_shared/normalize-target-cwd";

const TRASH_TIMEOUT_MS = 5000;
const HEADER_READ_MAX = 8192;
const COPY_CHUNK_SIZE = 65_536;

function getBranchSelectionWarning(
    sourceSessionFile: string,
    currentLeafId: string | null,
    commandName: string,
    actionName: string,
): string | null {
    try {
        const persistedSession = SessionManager.open(sourceSessionFile);
        const hasPersistedEntries = persistedSession.getEntries().length > 0;
        if (!hasPersistedEntries) {
            return null;
        }

        const persistedLeafId = persistedSession.getLeafId() as string | null;
        if (currentLeafId === null) {
            return `${commandName} will not preserve the current /tree root selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }

        if (currentLeafId !== persistedLeafId) {
            return `${commandName} will not preserve the current /tree selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }
    } catch {
        // Ignore warning-detection failures
    }

    return null;
}

/**
 * Remove parentSession from the first JSONL header line without loading
 * the entire file into memory
 */
function clearParentSession(sessionFile: string): void {
    const fd = openSync(sessionFile, "r");
    const headerBuffer = Buffer.alloc(HEADER_READ_MAX);
    const bytesRead = readSync(fd, headerBuffer, 0, HEADER_READ_MAX, 0);
    const headerChunk = headerBuffer.toString("utf-8", 0, bytesRead);
    const newlineIndex = headerChunk.indexOf("\n");

    if (newlineIndex === -1) {
        closeSync(fd);
        return;
    }

    const header = JSON.parse(headerChunk.slice(0, newlineIndex));
    if (!header.parentSession) {
        closeSync(fd);
        return;
    }

    delete header.parentSession;
    const newHeaderLine = JSON.stringify(header) + "\n";
    const originalHeaderBytes = Buffer.byteLength(headerChunk.slice(0, newlineIndex + 1), "utf-8");

    const temporaryPath = sessionFile + ".move-session-tmp";
    let writeFd: number | undefined;
    try {
        writeFd = openSync(temporaryPath, "w");
        const newHeaderBuffer = Buffer.from(newHeaderLine, "utf-8");
        writeSync(writeFd, newHeaderBuffer, 0, newHeaderBuffer.length);

        const copyBuffer = Buffer.alloc(COPY_CHUNK_SIZE);
        let position = originalHeaderBytes;
        for (;;) {
            const readCount = readSync(fd, copyBuffer, 0, COPY_CHUNK_SIZE, position);
            if (readCount === 0) break;
            writeSync(writeFd, copyBuffer, 0, readCount);
            position += readCount;
        }

        closeSync(writeFd);
        writeFd = undefined;
        closeSync(fd);
        renameSync(temporaryPath, sessionFile);
    } catch (error) {
        if (writeFd !== undefined) {
            try {
                closeSync(writeFd);
            } catch {
                // ignore cleanup close errors
            }
        }

        closeSync(fd);
        try {
            unlinkSync(temporaryPath);
        } catch {
            // ignore cleanup unlink errors
        }
        throw error;
    }
}

// Recycle-bin commands, tried in order. Each reads the file path from PI_TRASH_PATH or its last argument.
function trashCommands(filePath: string): Array<[string, string[]]> {
    const commands: Array<[string, string[]]> = [["trash", [filePath]]];
    if (process.platform === "win32") {
        commands.push(["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PI_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"]]);
    } else if (process.platform === "darwin") {
        commands.push(["osascript", ["-e", "on run argv", "-e", "tell application \"Finder\" to delete (POSIX file (item 1 of argv))", "-e", "end run", filePath]]);
    } else {
        commands.push(["gio", ["trash", filePath]], ["trash-put", [filePath]]);
    }
    return commands;
}

// Never permanently delete session files. If no recycle-bin command works, keep the old file.
export async function trashFileBestEffort(filePath: string): Promise<boolean> {
    const env = { ...process.env, PI_TRASH_PATH: filePath };
    for (const [command, args] of trashCommands(filePath)) {
        const ok = await new Promise<boolean>((resolve) => {
            execFile(command, args, { env, timeout: TRASH_TIMEOUT_MS, windowsHide: true }, (error) => resolve(!error));
        });
        if (ok) return true;
    }
    return false;
}

export default function (pi: ExtensionAPI) {
    // From a move_session call until the run ends, no other tool may run in the old directory.
    let blockOtherTools = false;
    // The run's abort signal of an agent-requested move. Only those moves continue the agent afterwards.
    let agentMoveSignal: AbortSignal | undefined;

    pi.on("tool_call", async (event) => {
        if (blockOtherTools) {
            return { block: true, reason: "A session move is pending. End your turn now. You continue in the target directory.", terminate: true };
        }
        if (event.toolName === "move_session") blockOtherTools = true;
    });
    pi.on("agent_end", async () => {
        blockOtherTools = false;
    });

    const resolveTargetCwd = async (rawTargetCwd: string, cwd: string): Promise<string> => {
        if (!isMainWorktreeTarget(rawTargetCwd)) {
            return normalizeTargetCwd(rawTargetCwd, process.env, cwd);
        }

        const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 5000 });
        if (result.code !== 0) {
            const stderr = result.stderr.trim();
            throw new Error(stderr || `git worktree list --porcelain failed with code ${result.code}`);
        }

        return getMainWorktreeRootFromWorktreeList(result.stdout);
    };

    const resolveExistingDirectory = async (rawTargetCwd: string, cwd: string): Promise<string> => {
        const targetCwd = await resolveTargetCwd(rawTargetCwd, cwd);
        let targetCwdStat;
        try {
            targetCwdStat = statSync(targetCwd);
        } catch (error: any) {
            throw new Error(error?.code === "ENOENT" ? `Path does not exist: ${targetCwd}` : `Cannot access path: ${targetCwd}`);
        }
        if (!targetCwdStat.isDirectory()) throw new Error(`Not a directory: ${targetCwd}`);
        return targetCwd;
    };

    pi.registerTool({
        name: "move_session",
        label: "Move session",
        description:
            "Move this session to another existing directory, for example a git worktree, and continue there. " +
            "The conversation moves with the session. Pi reloads tools, context files, and project configuration from the target. " +
            "Background processes, subagents, and SSH connections of this session stop.",
        promptSnippet: "Move this session to another directory, such as a git worktree",
        promptGuidelines: [
            "When you choose another directory as your task workspace, call move_session before editing or testing there.",
            "After creating a task worktree, your next tool call must be move_session with that worktree's path.",
            "Do not substitute shell cd, absolute paths, or tool working-directory options for moving the session.",
            "Call move_session alone. Pi continues the task automatically after the move; no user reply is needed.",
            "You may read reference files or use existing build tools outside the task workspace without moving.",
        ],
        parameters: Type.Object({
            path: Type.String({
                description: `Target directory: absolute, relative to the current directory, ~, or ${MAIN_WORKTREE_TOKEN}`,
            }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            let targetCwd: string;
            try {
                targetCwd = await resolveExistingDirectory(params.path.trim(), ctx.cwd);
                if (targetCwd === ctx.cwd) throw new Error(`The session is already in ${targetCwd}`);
                if (!ctx.sessionManager.getSessionFile()) throw new Error("No persistent session file (maybe started with --no-session)");
            } catch (error) {
                blockOtherTools = false;
                throw error;
            }

            agentMoveSignal = signal ?? new AbortController().signal;
            // Runs the command now. The command waits until this run ends.
            pi.sendUserMessage(`/move-session ${targetCwd}`, { expandPromptTemplates: true });
            return {
                content: [{ type: "text", text: `Session move to ${targetCwd} is queued. You continue in ${targetCwd}.` }],
                details: { targetCwd },
                terminate: true,
            };
        },
    });

    pi.registerCommand("move-session", {
        description: "Move session to another directory and continue there",
        getArgumentCompletions: (argumentPrefix: string) => {
            const trimmedPrefix = argumentPrefix.trimStart();
            if (!MAIN_WORKTREE_TOKEN.startsWith(trimmedPrefix)) {
                return null;
            }

            return [{
                value: MAIN_WORKTREE_TOKEN,
                label: MAIN_WORKTREE_TOKEN,
                description: "Move session to this repository's main git worktree",
            }];
        },
        handler: async (args, ctx) => {
            const moveSignal = agentMoveSignal;
            agentMoveSignal = undefined;
            const continueAgent = moveSignal !== undefined;
            await ctx.waitForIdle();

            if (moveSignal?.aborted) {
                ctx.ui.notify("Session move cancelled because the agent turn was aborted", "warning");
                return;
            }

            const rawTargetCwd = args.trim();
            if (!rawTargetCwd) {
                ctx.ui.notify("Usage: /move-session <targetCwd>", "error");
                return;
            }

            let targetCwd: string;
            try {
                targetCwd = await resolveExistingDirectory(rawTargetCwd, ctx.cwd);
            } catch (error: any) {
                ctx.ui.notify(error?.message ?? String(error), "error");
                return;
            }

            const sourceSessionFile = ctx.sessionManager.getSessionFile();
            if (!sourceSessionFile) {
                ctx.ui.notify("No persistent session file (maybe started with --no-session)", "error");
                return;
            }

            const branchSelectionWarning = getBranchSelectionWarning(
                sourceSessionFile,
                ctx.sessionManager.getLeafId() as string | null,
                "/move-session",
                "moving",
            );
            if (branchSelectionWarning) {
                ctx.ui.notify(branchSelectionWarning, "warning");
            }

            let destSessionFile: string | undefined;
            try {
                // Keep the session ID: providers key their prompt cache on it. IDs are unique per directory.
                const sessionId = ctx.sessionManager.getSessionId();
                const id = SessionManager.findById(targetCwd, sessionId) ? undefined : sessionId;
                destSessionFile = SessionManager.forkFrom(sourceSessionFile, targetCwd, undefined, { id }).getSessionFile();
            } catch (error: any) {
                ctx.ui.notify(`Failed to move session: ${error?.message ?? String(error)}`, "error");
                return;
            }
            if (!destSessionFile) {
                ctx.ui.notify("Internal error: forkFrom() produced no session file", "error");
                return;
            }

            // We intend to move/replace the original session, so avoid leaving
            // a parentSession pointer that may dangle after trashing the source.
            try {
                clearParentSession(destSessionFile);
            } catch (error: any) {
                ctx.ui.notify(
                    `Warning: could not clear parent session reference: ${error?.message ?? String(error)}`,
                    "warning"
                );
            }

            // After a successful switch, ctx and pi belong to the old session. Do not use them.
            await ctx.switchSession(destSessionFile, {
                // Runs only after a successful switch, before the agent continues.
                withSession: async (next) => {
                    void trashFileBestEffort(sourceSessionFile);
                    if (!continueAgent) return;
                    await next.sendMessage({
                        customType: "move-session",
                        content: `The session moved to ${targetCwd}. Your working directory is now ${targetCwd}. Continue the task there.`,
                        display: true,
                    }, { triggerTurn: true });
                },
            });
        },
    });
}
