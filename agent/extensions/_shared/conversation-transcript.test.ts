import { describe, expect, test } from "bun:test";
import { buildConversationTranscript } from "./conversation-transcript.ts";

const message = (role: "user" | "assistant", text: string) => ({
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

describe("buildConversationTranscript", () => {
  test("keeps the existing all-sections behavior when no limit is provided", () => {
    const transcript = buildConversationTranscript(
      [
        message("user", "first"),
        { type: "compaction", summary: "earlier context" },
        message("assistant", "reply"),
      ],
      false,
    );

    expect(transcript.sectionCount).toBe(3);
    expect(transcript.text).toContain("USER:\nfirst");
    expect(transcript.text).toContain("COMPACTION SUMMARY:\nearlier context");
    expect(transcript.text).toContain("ASSISTANT:\nreply");
  });

  test("limits output to the last N user or assistant messages", () => {
    const transcript = buildConversationTranscript(
      [
        message("user", "first"),
        message("assistant", "first reply"),
        { type: "branch_summary", summary: "alternate branch" },
        message("user", "second"),
        message("assistant", "second reply"),
      ],
      false,
      2,
    );

    expect(transcript).toEqual({
      text: "USER:\nsecond\n\n---\n\nASSISTANT:\nsecond reply",
      sectionCount: 2,
    });
  });

  test("excludes the active turn before applying the message limit", () => {
    const transcript = buildConversationTranscript(
      [
        message("user", "completed"),
        message("assistant", "completed reply"),
        message("user", "active"),
        message("assistant", "partial reply"),
      ],
      true,
      2,
    );

    expect(transcript.text).toBe(
      "USER:\ncompleted\n\n---\n\nASSISTANT:\ncompleted reply",
    );
    expect(transcript.sectionCount).toBe(2);
  });
});
