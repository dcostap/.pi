import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parsePatchActions } from "./patch/parser.ts";
import type { ExecutePatchResult } from "./patch/types.ts";
import {
  clearApplyPatchRenderState,
  markApplyPatchFailure,
  markApplyPatchPartialFailure,
  renderApplyPatchCallFromState,
  setApplyPatchRenderState,
} from "./tool/render-state.ts";

const TOOL_NAME = "apply_patch";
const ROOT = dirname(fileURLToPath(import.meta.url));
const BINARY = join(ROOT, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "apply_patch.exe" : "apply_patch");

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

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

export default function applyPatchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "apply_patch",
    description: "Patch files.",
    parameters: PARAMETERS,
    prepareArguments,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("apply_patch aborted");
      const input = params.input;
      if (typeof input !== "string") throw new Error("apply_patch requires a string input");

      // Parse before spawning so malformed patches fail without touching disk and can still render cleanly.
      parsePatchActions({ text: input });
      setApplyPatchRenderState(toolCallId, input, ctx.cwd);

      try {
        const response = await runPatch(ctx.cwd, input, signal);
        if (response.status === "success") {
          return {
            content: [{ type: "text" as const, text: "Applied patch successfully." }],
            details: { status: "success", result: response.result } satisfies PatchDetails,
          };
        }

        const message = response.error?.trim() || "apply_patch failed";
        if (changed(response.result)) {
          markApplyPatchPartialFailure(toolCallId);
          return {
            content: [{ type: "text" as const, text: `Patch partially applied: ${message}` }],
            details: { status: "partial_failure", result: response.result, error: message } satisfies PatchDetails,
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
      return new Text(renderApplyPatchCallFromState(args, theme, {
        ...context,
        showCollapsedDiff: true,
        outputTokens: streamedTokenEstimate(context.toolCallId),
      }), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as PatchDetails | undefined;
      if (details?.status === "success") return new Container();
      const text = textContent(result);
      if (!text) return new Container();
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
