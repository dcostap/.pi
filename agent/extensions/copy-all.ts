import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block)) return "";

      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      if (block.type === "image") return "[image]";

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function runClipboardProcess(
  command: string,
  args: string[],
  input: string,
  inputEncoding: BufferEncoding = "utf8"
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });

    child.stdin.end(input, inputEncoding);
  });
}

async function copyToClipboard(text: string) {
  if (process.platform === "win32") {
    // clip.exe decodes stdin using the active Windows console code page, so
    // UTF-8 text like em dashes becomes mojibake such as "ÔÇö". Send base64
    // ASCII instead and let PowerShell decode the original UTF-8 explicitly.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$base64 = [Console]::In.ReadToEnd()",
      "$bytes = [Convert]::FromBase64String($base64)",
      "$text = [System.Text.Encoding]::UTF8.GetString($bytes)",
      "Set-Clipboard -Value $text",
    ].join("; ");

    await runClipboardProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      Buffer.from(text, "utf8").toString("base64"),
      "ascii"
    );
    return;
  }

  await runClipboardProcess("pbcopy", [], text);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description:
      "Copy all previous user/assistant messages and summaries in this thread to the clipboard",
    handler: async (_args, ctx) => {
      let branchEntries = ctx.sessionManager.getBranch();

      // If copy-all is invoked while the agent is still working, copy only the
      // already-completed conversation. The active turn is still WIP and may not
      // be fully persisted yet, so ignore everything from the latest user
      // message onward.
      if (!ctx.isIdle()) {
        for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
          const entry = branchEntries[index];
          if (entry?.type === "message" && entry.message.role === "user") {
            branchEntries = branchEntries.slice(0, index);
            break;
          }
        }
      }

      const sections = branchEntries
        .map((entry) => {
          if (entry.type === "message") {
            const message = entry.message;
            if (message.role !== "user" && message.role !== "assistant") return undefined;

            const content = textFromContent(message.content).trim();
            if (!content) return undefined;

            return `${message.role.toUpperCase()}:\n${content}`;
          }

          if (entry.type === "compaction") {
            const summary = entry.summary?.trim();
            if (!summary) return undefined;
            return `COMPACTION SUMMARY:\n${summary}`;
          }

          if (entry.type === "branch_summary") {
            const summary = entry.summary?.trim();
            if (!summary) return undefined;
            return `BRANCH SUMMARY:\n${summary}`;
          }

          return undefined;
        })
        .filter((section): section is string => Boolean(section));

      const text = sections.join("\n\n---\n\n");

      if (!text) {
        ctx.ui.notify("No user, assistant, or summary messages to copy", "info");
        return;
      }

      await copyToClipboard(text);
      ctx.ui.notify(`Copied ${sections.length} sections to clipboard`, "info");
    },
  });
}
