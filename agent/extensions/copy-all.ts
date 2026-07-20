import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildConversationTranscript } from "./_shared/conversation-transcript.ts";

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
      const transcript = buildConversationTranscript(
        ctx.sessionManager.getBranch(),
        !ctx.isIdle(),
      );

      if (!transcript.text) {
        ctx.ui.notify("No user, assistant, or summary messages to copy", "info");
        return;
      }

      await copyToClipboard(transcript.text);
      ctx.ui.notify(`Copied ${transcript.sectionCount} sections to clipboard`, "info");
    },
  });
}
