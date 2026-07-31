import type { ChatMessage, InboxItem, MessageDelivery } from "./types.js";

export interface InboxEntry {
  item: InboxItem;
  path: string;
}

export interface ChatInboxEntry extends InboxEntry {
  item: ChatMessage;
}

const AUTO_DELIVERY_BATCH_SIZE = 5;

export function messageDelivery(message: ChatMessage): MessageDelivery {
  return message.delivery === "steer" ? "steer" : "inbox";
}

export function isChatInboxEntry(entry: InboxEntry): entry is ChatInboxEntry {
  return !("controlType" in entry.item);
}

export function buildInjectedMessengerText(
  message: Pick<ChatMessage, "kind" | "fromNameSnapshot" | "fromRoleSnapshot" | "replyTo" | "text">,
): string {
  const isBroadcast = message.kind === "broadcast";
  const tag = isBroadcast ? "global_messenger_broadcast" : "direct_messenger_message";
  const replyTag = message.replyTo ? `\n  <reply_to>${message.replyTo}</reply_to>` : "";
  return `<${tag}>\n  <sender>${message.fromNameSnapshot}</sender>\n  <role>${message.fromRoleSnapshot}</role>\n  <note>A reply is optional. Reply only with substantive information, questions, blockers, decisions, or requested results. Do not send an acknowledgement-only reply unless the sender explicitly requested one.</note>${replyTag}\n  <contents>\n${message.text}\n  </contents>\n</${tag}>`;
}

export function buildInjectedMessengerBatchText(messages: ChatMessage[]): string {
  const sorted = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const rendered = sorted.map((message, index) => {
    const isBroadcast = message.kind === "broadcast";
    const tag = isBroadcast ? "global_messenger_broadcast" : "direct_messenger_message";
    const replyTag = message.replyTo ? `\n    <reply_to>${message.replyTo}</reply_to>` : "";
    return `  <pending_message index="${index + 1}" of="${sorted.length}">\n    <type>${tag}</type>\n    <sender>${message.fromNameSnapshot}</sender>\n    <role>${message.fromRoleSnapshot}</role>\n    <created_at>${message.createdAt}</created_at>${replyTag}\n    <contents>\n${message.text}\n    </contents>\n  </pending_message>`;
  }).join("\n\n");
  return `<messenger_pending_messages>\n  <note>Process these messages in chronological order. Do not reply to each message. Reply only with substantive information, questions, blockers, decisions, or requested results, or when acknowledgement was explicitly requested.</note>\n${rendered}\n</messenger_pending_messages>`;
}

/**
 * Select the messages that the background poller may inject now.
 *
 * Idle delivery preserves the ordinary chronological batch. While an agent is
 * active, normal inbox messages remain queued and only explicit steering
 * messages are selected. Control requests form an ordering boundary because
 * they must be handled by the control path first.
 */
export function selectAutomaticChatEntries(entries: InboxEntry[], idle: boolean): ChatInboxEntry[] {
  const selected: ChatInboxEntry[] = [];
  for (const entry of entries) {
    if (!isChatInboxEntry(entry)) break;
    if (idle || messageDelivery(entry.item) === "steer") selected.push(entry);
    if (selected.length >= AUTO_DELIVERY_BATCH_SIZE) break;
  }
  return selected;
}

/** Return every currently queued normal or steering chat message. */
export function selectCheckInboxEntries(entries: InboxEntry[]): ChatInboxEntry[] {
  return entries.filter(isChatInboxEntry);
}
