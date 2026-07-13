import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parsePatchActions } from "./patch/parser.ts";
import type { ExecutePatchResult, ParsedPatchAction } from "./patch/types.ts";
import {
  clearApplyPatchRenderState,
  markApplyPatchFailure,
  markApplyPatchPartialFailure,
  renderApplyPatchCallFromState,
  setApplyPatchRenderState,
  type ApplyPatchSettledStatus,
} from "./tool/render-state.ts";
import { formatPatchTarget } from "./tool/rendering.ts";

const TOOL_NAME = "apply_patch";
const ROOT = dirname(fileURLToPath(import.meta.url));
const BINARY = join(ROOT, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "apply_patch.exe" : "apply_patch");
const CODEX_APPLY_PATCH_GUIDANCE = "Use `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.";

const PARAMETERS = Type.Object({
  input: Type.String({
    description: "Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.",
  }),
});

const outputCharsByToolCallId = new Map<string, number>();

function toolCallFromEvent(event: AssistantMessageEvent): { id: string; name: string } | undefined {
  if (event.type === "toolcall_end") return { id: event.toolCall.id, name: event.toolCall.name };
  if (event.type !== "toolcall_delta" && event.type !== "toolcall_start") return undefined;
  const block = event.partial.content[event.contentIndex];
  if (!block || block.type !== "toolCall") return undefined;
  return { id: block.id, name: block.name };
}

function streamedTokenEstimate(toolCallId?: string): number {
  if (!toolCallId) return 0;
  return Math.ceil((outputCharsByToolCallId.get(toolCallId) ?? 0) / 4);
}

interface BinaryResponse {
  status: "success" | "failure";
  error?: string | null;
  result: ExecutePatchResult;
}

interface PatchDetails {
  status: "success" | "partial_failure";
  result: ExecutePatchResult;
  error?: string;
  attemptedFiles?: string[];
  appliedFiles?: string[];
  failedFiles?: string[];
}

interface ApplyPatchRendererState {
  callComponent?: Box;
  settledStatus?: ApplyPatchSettledStatus;
}

function isCodexLike(ctx: ExtensionContext): boolean {
  const provider = (ctx.model?.provider ?? "").toLowerCase();
  const api = (ctx.model?.api ?? "").toLowerCase();
  const id = (ctx.model?.id ?? "").toLowerCase();
  const copilotGpt = (provider.includes("copilot") || api.includes("copilot")) && id.includes("gpt");
  return provider.includes("codex") || api.includes("codex") || id.includes("codex") || (provider.includes("openai") && id.includes("gpt")) || copilotGpt;
}

let removedEdit = false;

function syncTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const active = pi.getActiveTools();
  const next = new Set(active);

  if (isCodexLike(ctx)) {
    next.add(TOOL_NAME);
    if (next.delete("edit")) removedEdit = true;
  } else {
    next.delete(TOOL_NAME);
    if (removedEdit) {
      next.add("edit");
      removedEdit = false;
    }
  }

  const updated = [...next];
  if (updated.length === active.length && updated.every((name, index) => name === active[index])) return;
  pi.setActiveTools(updated);
}

function prepareArguments(args: unknown): { input: string } {
  if (args && typeof args === "object") {
    const value = args as Record<string, unknown>;
    if (typeof value.input === "string") return { input: value.input };
    if (typeof value.patch === "string") return { input: value.patch };
    if (typeof value.patchText === "string") return { input: value.patchText };
  }
  return args as { input: string };
}

function runPatch(cwd: string, input: string, signal?: AbortSignal): Promise<BinaryResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, [], {
      cwd,
      env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("apply_patch aborted"));
      const jsonLine = stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
      if (!jsonLine) return reject(new Error(stderr.trim() || stdout.trim() || "apply_patch returned no structured result"));
      try {
        const parsed = JSON.parse(jsonLine) as BinaryResponse;
        if (!parsed.result || (parsed.status !== "success" && parsed.status !== "failure")) throw new Error("invalid result shape");
        resolve(parsed);
      } catch (error) {
        reject(new Error(`apply_patch returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(input);
  });
}

function changed(result: ExecutePatchResult): boolean {
  return result.changedFiles.length > 0 || result.createdFiles.length > 0 || result.deletedFiles.length > 0 || result.movedFiles.length > 0;
}

function pathKey(cwd: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const normalized = absolute.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function classifyActions(
  actions: ParsedPatchAction[],
  result: ExecutePatchResult,
  cwd: string,
): { attemptedFiles: string[]; appliedFiles: string[]; failedFiles: string[] } {
  const changedPaths = new Set(result.changedFiles.map((path) => pathKey(cwd, path)));
  const attemptedFiles: string[] = [];
  const appliedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const action of actions) {
    const target = formatPatchTarget(action.path, action.movePath, cwd);
    const mutationPaths = action.movePath ? [action.path, action.movePath] : [action.path];
    const applied = mutationPaths.every((path) => changedPaths.has(pathKey(cwd, path)));
    attemptedFiles.push(target);
    (applied ? appliedFiles : failedFiles).push(target);
  }

  return { attemptedFiles, appliedFiles, failedFiles };
}

function dedupeRepeatedError(message: string): string {
  // Some lower-level errors arrive as "message: message" after being wrapped.
  // Keep one copy for both the model result and the expanded UI details.
  let separator = message.indexOf(": ");
  while (separator !== -1) {
    const first = message.slice(0, separator);
    const second = message.slice(separator + 2);
    if (first === second) return first;
    separator = message.indexOf(": ", separator + 2);
  }
  return message;
}

function partialFailureText(details: PatchDetails, rawText: string, expanded: boolean, theme: any): string {
  const attempted = details.attemptedFiles?.length ?? 0;
  const applied = details.appliedFiles?.length ?? details.result.changedFiles.length;
  const countText = attempted > 0
    ? `${applied} of ${attempted} ${attempted === 1 ? "file" : "files"} changed`
    : `${details.result.changedFiles.length} ${details.result.changedFiles.length === 1 ? "file was" : "files were"} changed`;
  const failedFile = details.failedFiles?.[0];
  const error = dedupeRepeatedError(details.error?.trim() || rawText.replace(/^Patch partially applied:\s*/, "").trim());
  const expectedLinesMissing = /Failed to find (?:expected lines|context)\b/i.test(error);
  const reason = expectedLinesMissing
    ? `Expected lines no longer matched${failedFile ? ` in ${failedFile}` : " the file"}.`
    : error.split(/\r?\n/, 1)[0] || "One or more edits could not be applied.";
  const lines = [
    `${theme.fg("warning", "⚠ Partially applied")}${theme.fg("muted", ` — ${countText}`)}`,
    theme.fg("dim", `  ${reason}`),
  ];
  if (expanded && error) {
    lines.push("", ...error.split(/\r?\n/).map((line) => theme.fg("dim", line)));
  }
  return lines.join("\n");
}

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function settledStatus(details: PatchDetails | undefined, isError: boolean): ApplyPatchSettledStatus {
  if (isError) return "failed";
  return details?.status === "partial_failure" ? "partial_failure" : "success";
}

function renderCallComponent(
  component: Box,
  args: { input?: unknown },
  theme: any,
  context: any,
  status?: ApplyPatchSettledStatus,
): Box {
  const rendered = renderApplyPatchCallFromState(args, theme, {
    ...context,
    showCollapsedDiff: true,
    outputTokens: streamedTokenEstimate(context.toolCallId),
    settledStatus: status,
  });

  component.setBgFn(status === "failed" || context.isError
    ? (text: string) => theme.bg("toolErrorBg", text)
    : status === "partial_failure"
      ? (text: string) => theme.bg("toolPendingBg", text)
      : status === "success" || context.argsComplete
        ? (text: string) => theme.bg("toolSuccessBg", text)
        : (text: string) => theme.bg("toolPendingBg", text));
  component.clear();
  const [header = "", ...diffLines] = rendered.split("\n");
  component.addChild(new Text(header, 0, 0));
  if (diffLines.length > 0) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(diffLines.join("\n"), 0, 0));
  }
  return component;
}

export default function applyPatchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "apply_patch",
    description: "Use the `apply_patch` tool to edit files.",
    promptGuidelines: [CODEX_APPLY_PATCH_GUIDANCE],
    parameters: PARAMETERS,
    renderShell: "self",
    prepareArguments,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("apply_patch aborted");
      const input = params.input;
      if (typeof input !== "string") throw new Error("apply_patch requires a string input");

      // Parse before spawning so malformed patches fail without touching disk and can still render cleanly.
      const actions = parsePatchActions({ text: input });
      setApplyPatchRenderState(toolCallId, input, ctx.cwd);

      try {
        const response = await runPatch(ctx.cwd, input, signal);
        if (response.status === "success") {
          return {
            content: [{ type: "text" as const, text: "Applied patch successfully." }],
            details: { status: "success", result: response.result } satisfies PatchDetails,
          };
        }

        const message = dedupeRepeatedError(response.error?.trim() || "apply_patch failed");
        if (changed(response.result)) {
          const actionStatus = classifyActions(actions, response.result, ctx.cwd);
          markApplyPatchPartialFailure(toolCallId, actionStatus.failedFiles);
          return {
            content: [{ type: "text" as const, text: `Patch partially applied: ${message}` }],
            details: {
              status: "partial_failure",
              result: response.result,
              error: message,
              ...actionStatus,
            } satisfies PatchDetails,
          };
        }
        markApplyPatchFailure(toolCallId, "failed");
        throw new Error(message);
      } catch (error) {
        markApplyPatchFailure(toolCallId, "failed");
        throw error;
      }
    },
    renderCall(args, theme, context) {
      const state = context.state as ApplyPatchRendererState;
      const component = context.lastComponent instanceof Box
        ? context.lastComponent
        : state.callComponent ?? new Box(1, 1, (text: string) => text);
      state.callComponent = component;

      // Match native edit's component structure: its header and diff are
      // separate Text children inside a self-rendered Box. Keeping the OSC 8
      // file link out of the diff Text also prevents ANSI state from leaking
      // into wrapped diff lines and breaking the background fill.
      return renderCallComponent(component, args, theme, context, state.settledStatus);
    },
    renderResult(result, options, theme, context) {
      let details = result.details as PatchDetails | undefined;
      const state = context.state as ApplyPatchRendererState;
      if (
        details?.status === "partial_failure" &&
        !details.attemptedFiles &&
        typeof context.args.input === "string"
      ) {
        try {
          details = {
            ...details,
            ...classifyActions(parsePatchActions({ text: context.args.input }), details.result, context.cwd),
          };
        } catch {
          // Older session entries may not contain enough detail to classify each file.
        }
      }
      state.settledStatus = settledStatus(details, context.isError);
      if (details?.status === "partial_failure" && typeof context.args.input === "string") {
        setApplyPatchRenderState(
          context.toolCallId,
          context.args.input,
          context.cwd,
          "partial_failure",
          details.failedFiles,
        );
      }
      if (state.callComponent) {
        renderCallComponent(state.callComponent, context.args, theme, context, state.settledStatus);
      }
      if (details?.status === "success") return new Container();
      const text = textContent(result);
      if (!text) return new Container();
      if (details?.status === "partial_failure") {
        return new Text(partialFailureText(details, text, options.expanded, theme), 0, 0);
      }
      return new Text(theme.fg(context.isError ? "error" : "warning", text), 0, 0);
    },
  });

  pi.on("agent_start", () => outputCharsByToolCallId.clear());
  pi.on("message_update", (event) => {
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "toolcall_delta") return;
    const toolCall = toolCallFromEvent(streamEvent);
    if (!toolCall || toolCall.name !== TOOL_NAME) return;
    outputCharsByToolCallId.set(
      toolCall.id,
      (outputCharsByToolCallId.get(toolCall.id) ?? 0) + streamEvent.delta.length,
    );
  });
  pi.on("agent_end", () => outputCharsByToolCallId.clear());

  pi.on("session_start", (_event, ctx) => {
    clearApplyPatchRenderState();
    outputCharsByToolCallId.clear();
    syncTool(pi, ctx);
  });
  pi.on("model_select", (_event, ctx) => syncTool(pi, ctx));
  pi.on("session_shutdown", () => {
    clearApplyPatchRenderState();
    outputCharsByToolCallId.clear();
  });
}
