import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  message: {
    role: string;
    content?: unknown;
  };
};

function isUserMessageEntry(entry: unknown): entry is MessageEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "message" &&
    typeof (entry as { id?: unknown }).id === "string" &&
    "message" in entry &&
    typeof (entry as { message?: { role?: unknown } }).message === "object" &&
    (entry as { message?: { role?: unknown } }).message?.role === "user"
  );
}

function textFromUserContent(content: unknown): { text: string; ignoredImages: number } {
  if (typeof content === "string") return { text: content, ignoredImages: 0 };
  if (!Array.isArray(content)) return { text: "", ignoredImages: 0 };

  const textParts: string[] = [];
  let ignoredImages = 0;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
    } else if (typed.type === "image") {
      ignoredImages++;
    }
  }

  return { text: textParts.join("\n"), ignoredImages };
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 80) return oneLine || "(empty prompt)";
  return `${oneLine.slice(0, 77)}...`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("undo", {
    description: "Abort if needed, jump before a previous user prompt, and put it back in the editor. Usage: /undo [1=last, 2=previous, ...]",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.abort();
      }
      await ctx.waitForIdle();

      const requested = args.trim();
      const n = requested === "" ? 1 : Number.parseInt(requested, 10);
      if (!Number.isFinite(n) || n < 1) {
        ctx.ui.notify("Usage: /undo [1=last, 2=previous, ...]", "warning");
        return;
      }

      const userEntries = ctx.sessionManager.getBranch().filter(isUserMessageEntry);
      const target = userEntries[userEntries.length - n];
      if (!target) {
        ctx.ui.notify(`No user prompt found for /undo ${n}.`, "warning");
        return;
      }

      const { text, ignoredImages } = textFromUserContent(target.message.content);
      if (!text && ignoredImages > 0) {
        ctx.ui.notify("That prompt only contained image content; /undo can only restore text.", "warning");
        return;
      }

      if (target.parentId) {
        const result = await ctx.navigateTree(target.parentId, { summarize: false });
        if (result?.cancelled) return;
      } else {
        // First message in the session has no parent node. The public command API only
        // navigates to concrete entries, so use SessionManager's resetLeaf escape hatch.
        const sessionManager = ctx.sessionManager as unknown as { resetLeaf?: () => void };
        if (typeof sessionManager.resetLeaf !== "function") {
          ctx.ui.notify("Can't jump before the first prompt in this pi version.", "warning");
          return;
        }
        sessionManager.resetLeaf();
      }

      ctx.ui.setEditorText(text);

      const imageNote = ignoredImages > 0 ? ` (${ignoredImages} image${ignoredImages === 1 ? "" : "s"} not restored)` : "";
      ctx.ui.notify(`Editing: ${preview(text)}${imageNote}`, "info");
    },
  });
}
