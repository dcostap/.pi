import { describe, expect, test } from "bun:test";

import {
  buildInjectedMessengerBatchText,
  buildInjectedMessengerText,
  selectAutomaticChatEntries,
  selectCheckInboxEntries,
} from "./messages.ts";
import type { ChatMessage, InboxItem } from "./types.ts";

function message(id: string, delivery: "inbox" | "steer" = "inbox", createdAt = `2026-01-01T00:00:0${id}.000Z`): ChatMessage {
  return {
    version: 1,
    id,
    kind: "direct",
    fromSessionId: "sender",
    fromNameSnapshot: "Sender",
    fromRoleSnapshot: "worker",
    fromIsHuman: false,
    toSessionIds: ["recipient"],
    toNameSnapshots: ["Recipient"],
    text: `message ${id}`,
    createdAt,
    delivery,
  };
}

function entry(item: InboxItem) {
  return { item, path: `${"id" in item ? item.id : item.requestId}.json` };
}

describe("messenger message delivery", () => {
  test("single-message instructions forbid acknowledgement-only replies", () => {
    const rendered = buildInjectedMessengerText(message("1"));

    expect(rendered).toContain("A reply is optional");
    expect(rendered).toContain("Do not send an acknowledgement-only reply");
    expect(rendered).not.toContain("To reply, use the messenger tool");
  });

  test("pending-message batches are chronological and do not demand individual replies", () => {
    const rendered = buildInjectedMessengerBatchText([
      message("2", "inbox", "2026-01-01T00:00:02.000Z"),
      message("1", "inbox", "2026-01-01T00:00:01.000Z"),
    ]);

    expect(rendered.indexOf("message 1")).toBeLessThan(rendered.indexOf("message 2"));
    expect(rendered).toContain("Do not reply to each message");
    expect(rendered).not.toContain("Handle each one separately");
  });

  test("working delivery selects only steering messages without consuming inbox messages", () => {
    const inbox = entry(message("1", "inbox"));
    const steer = entry(message("2", "steer"));

    expect(selectAutomaticChatEntries([inbox, steer], false).map((candidate) => candidate.item.id)).toEqual(["2"]);
    expect(selectAutomaticChatEntries([inbox, steer], true).map((candidate) => candidate.item.id)).toEqual(["1", "2"]);
  });

  test("messages from older versions default to normal inbox delivery", () => {
    const legacy = message("1");
    delete legacy.delivery;
    const candidate = entry(legacy);

    expect(selectAutomaticChatEntries([candidate], false)).toEqual([]);
    expect(selectAutomaticChatEntries([candidate], true).map((item) => item.item.id)).toEqual(["1"]);
  });

  test("explicit inbox checks return the whole pending chat chain", () => {
    const entries = [entry(message("1")), entry(message("2", "steer"))];

    expect(selectCheckInboxEntries(entries).map((candidate) => candidate.item.id)).toEqual(["1", "2"]);
  });
});
