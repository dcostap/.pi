export type ConversationTranscript = {
  text: string;
  sectionCount: number;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || !("type" in block)) return "";

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

/**
 * Build the same plain-text conversation transcript used by /copy-all.
 * When excludeActiveTurn is true, the latest user message and everything
 * after it are omitted so an in-progress turn is never included.
 * When maxMessages is provided, only the latest user/assistant messages are
 * returned; summaries are retained only for the unlimited transcript.
 */
export function buildConversationTranscript(
  entries: readonly any[],
  excludeActiveTurn: boolean,
  maxMessages?: number,
): ConversationTranscript {
  let branchEntries = [...entries];

  if (excludeActiveTurn) {
    for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
      const entry = branchEntries[index];
      if (entry?.type === "message" && entry.message?.role === "user") {
        branchEntries = branchEntries.slice(0, index);
        break;
      }
    }
  }

  let sections = branchEntries
    .map((entry) => {
      if (entry.type === "message") {
        const message = entry.message;
        if (message.role !== "user" && message.role !== "assistant") return undefined;

        const content = textFromContent(message.content).trim();
        if (!content) return undefined;
        return {
          text: `${message.role.toUpperCase()}:\n${content}`,
          isMessage: true,
        };
      }

      if (entry.type === "compaction") {
        const summary = entry.summary?.trim();
        if (!summary) return undefined;
        return { text: `COMPACTION SUMMARY:\n${summary}`, isMessage: false };
      }

      if (entry.type === "branch_summary") {
        const summary = entry.summary?.trim();
        if (!summary) return undefined;
        return { text: `BRANCH SUMMARY:\n${summary}`, isMessage: false };
      }

      return undefined;
    })
    .filter((section): section is { text: string; isMessage: boolean } => Boolean(section));

  if (maxMessages !== undefined && maxMessages > 0) {
    sections = sections.filter((section) => section.isMessage).slice(-maxMessages);
  }

  return {
    text: sections.map((section) => section.text).join("\n\n---\n\n"),
    sectionCount: sections.length,
  };
}
