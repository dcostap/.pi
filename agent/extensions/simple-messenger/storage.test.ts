import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countPendingInboxMessages,
  enqueueInboxMessage,
  removeInboxMessage,
  consumeInbox,
} from "./storage.ts";
import type { ChatMessage, ProjectInfo, ResetContextBeforeMessageRequest } from "./types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): ProjectInfo {
  const root = mkdtempSync(join(tmpdir(), "simple-messenger-test-"));
  roots.push(root);
  return {
    key: "test",
    label: "test",
    rootDir: root,
    scopePath: root,
    scopeKind: "cwd",
    projectDir: join(root, "messenger"),
  };
}

function message(id: string): ChatMessage {
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
    text: id,
    createdAt: new Date().toISOString(),
    delivery: "inbox",
  };
}

describe("messenger inbox counts", () => {
  test("tracks only unread chat messages and updates after consumption", () => {
    const info = project();
    enqueueInboxMessage(info, "recipient", message("one"));
    enqueueInboxMessage(info, "recipient", message("two"));
    const control: ResetContextBeforeMessageRequest = {
      version: 1,
      controlType: "reset_context_before_message",
      requestId: "reset",
      deliveryKind: "direct",
      senderSessionId: "sender",
      senderNameSnapshot: "Sender",
      senderRoleSnapshot: "worker",
      senderIsHuman: false,
      recipientSessionId: "recipient",
      recipientNameSnapshot: "Recipient",
      text: "reset",
      createdAt: new Date().toISOString(),
    };
    enqueueInboxMessage(info, "recipient", control);

    expect(countPendingInboxMessages(info, "recipient")).toBe(2);
    const first = consumeInbox(info, "recipient").find((entry) => !("controlType" in entry.item))!;
    removeInboxMessage(first.path);
    expect(countPendingInboxMessages(info, "recipient")).toBe(1);
  });
});
