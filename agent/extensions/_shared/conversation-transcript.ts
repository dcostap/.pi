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
 */
export function buildConversationTranscript(
  entries: readonly any[],
  excludeActiveTurn: boolean,
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

  return {
    text: sections.join("\n\n---\n\n"),
    sectionCount: sections.length,
  };
}
