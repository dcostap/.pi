import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfig, matchesPathPattern } from "./config.js";
import { detectProjectInfo } from "./git.js";
import { generateAgentName } from "./names.js";
import { MessengerPanel } from "./overlay.js";
import {
  appendMessage,
  buildThreads,
  cleanupInbox,
  consumeInbox,
  ensureInbox,
  ensureProjectDirs,
  enqueueInboxMessage,
  formatRelativeTime,
  getAgentByName,
  isNameTaken,
  readActiveAgents,
  readIdleWatchStore,
  readResetContextBeforeMessageResult,
  removeInboxMessage,
  removeRegistry,
  removeResetContextBeforeMessageResult,
  writeIdleWatchStore,
  writeRegistry,
  writeResetContextBeforeMessageResult,
} from "./storage.js";
import type {
  AgentRegistration,
  ChatMessage,
  IdleWatchRule,
  IdleWatchStore,
  IdleWatchTarget,
  PresenceState,
  ResetContextBeforeMessageRequest,
  ResetContextBeforeMessageResult,
  RuntimeState,
  ThreadSummary,
} from "./types.js";

const ToolParams = Type.Object({
  action: Type.Optional(Type.Unsafe<ToolParamsType["action"]>({
    type: "string",
    enum: ["join", "leave", "status", "send", "broadcast", "rename", "warn_me_when_idle", "warn_me_when_idle.list", "warn_me_when_idle.remove", "warn_me_when_idle.clear", "warn_me_when_working", "warn_me_when_working.list", "warn_me_when_working.remove", "warn_me_when_working.clear"],
    description: "Messenger action. Use status to inspect the current messenger roster, send for direct agent messages, broadcast for project-wide notes, and warn_me_when_idle / warn_me_when_working to configure private presence alerts.",
  })),
  to: Type.Optional(Type.Union([
    Type.String({ description: "Recipient agent name for action: 'send'." }),
    Type.Array(Type.String(), { description: "Multiple recipient agent names for action: 'send'." }),
  ])),
  message: Type.Optional(Type.String({
    description: "Message body for send or broadcast. This is the exact text delivered to other agents.",
  })),
  replyTo: Type.Optional(Type.String({
    description: "Optional message ID being replied to. Use when continuing a thread with another agent so recipients can see reply context.",
  })),
  completely_wipe_recipient_context_before_message: Type.Optional(Type.Boolean({
    description: "Dangerous. When true, each recipient resets their active conversation context before this message is delivered. The delivered message becomes the first prompt of a new root branch while messenger identity is preserved.",
  })),
  name: Type.Optional(Type.String({
    description: "New agent name for action: 'rename'.",
  })),
  targetName: Type.Optional(Type.String({
    description: "Target agent name for action: 'warn_me_when_idle' or 'warn_me_when_working'. Provide either targetName or targetRole, not both.",
  })),
  targetRole: Type.Optional(Type.String({
    description: "Target role for action: 'warn_me_when_idle' or 'warn_me_when_working'. Provide either targetName or targetRole, not both.",
  })),
  minutes: Type.Optional(Type.Number({
    description: "Threshold in minutes for action: 'warn_me_when_idle' or 'warn_me_when_working'.",
  })),
  enabled: Type.Optional(Type.Boolean({
    description: "Enable or disable the idle warning rule when creating/updating it.",
  })),
  id: Type.Optional(Type.String({
    description: "Optional rule id for warn_me_when_idle / warn_me_when_working actions. Omit to update the matching rule for the same target and same watch mode.",
  })),
});

type ToolParamsType = {
  action?: "join" | "leave" | "status" | "send" | "broadcast" | "rename" | "warn_me_when_idle" | "warn_me_when_idle.list" | "warn_me_when_idle.remove" | "warn_me_when_idle.clear" | "warn_me_when_working" | "warn_me_when_working.list" | "warn_me_when_working.remove" | "warn_me_when_working.clear";
  to?: string | string[];
  message?: string;
  replyTo?: string;
  completely_wipe_recipient_context_before_message?: boolean;
  name?: string;
  targetName?: string;
  targetRole?: string;
  minutes?: number;
  enabled?: boolean;
  id?: string;
};

type LatestCtx = ExtensionContext | null;

function result(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function modelLabel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export default function simpleMessenger(pi: ExtensionAPI) {
  let config = loadConfig(process.cwd());
  const state: RuntimeState = {
    sessionId: randomUUID(),
    joined: false,
    agentName: "",
    agentRole: "agent",
    pollTimer: null,
    lastRegistryWriteAt: 0,
    currentModel: undefined,
    project: detectProjectInfo(process.cwd()),
    presenceState: "idle",
    presenceSince: new Date().toISOString(),
  };

  let latestCtx: LatestCtx = null;
  let joinedAt = new Date().toISOString();
  let lastActivityAt = new Date().toISOString();
  let lastRegistryWriteErrorAt = 0;
  let messengerToolRegistered = false;
  let watchStore: IdleWatchStore = { version: 1, rules: [] };
  const COMPACTION_DELIVERY_GRACE_MS = 2500;
  const COMPACTION_DELIVERY_FAILSAFE_MS = 5 * 60 * 1000;
  const WORKING_TO_IDLE_GRACE_MS = 15_000;
  let compactionInProgress = false;
  let messengerDeliveryPausedUntil = 0;
  let idleTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  function withCtx(ctx?: ExtensionContext | null): ExtensionContext | null {
    return ctx ?? latestCtx;
  }

  function pauseAgentTriggeredDelivery(ms: number): void {
    messengerDeliveryPausedUntil = Date.now() + ms;
  }

  function isAgentTriggeredDeliveryPaused(): boolean {
    const now = Date.now();
    if (compactionInProgress) {
      if (messengerDeliveryPausedUntil > 0 && now > messengerDeliveryPausedUntil) {
        compactionInProgress = false;
      } else {
        return true;
      }
    }
    return now < messengerDeliveryPausedUntil;
  }

  function canTriggerAgentFromPoll(ctx: ExtensionContext): boolean {
    return !isAgentTriggeredDeliveryPaused() && ctx.isIdle() && !ctx.hasPendingMessages();
  }

  function refreshProject(cwd?: string): void {
    state.project = detectProjectInfo(cwd ?? process.cwd());
    config = loadConfig(cwd ?? process.cwd());
    ensureProjectDirs(state.project);
  }

  function loadPrivateWatchStore(): void {
    if (!state.agentName) return;
    watchStore = readIdleWatchStore(state.agentName);
  }

  function savePrivateWatchStore(): void {
    if (!state.agentName) return;
    writeIdleWatchStore(state.agentName, watchStore);
  }

  function currentNamesMap(): Map<string, string> {
    return new Map(readActiveAgents(state.project).map((agent) => [agent.sessionId, agent.name]));
  }

  function currentRolesMap(): Map<string, string> {
    return new Map(readActiveAgents(state.project).map((agent) => [agent.sessionId, agent.role]));
  }

  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function setPresence(next: PresenceState, ctx?: ExtensionContext | null, since = new Date().toISOString()): void {
    state.presenceState = next;
    state.presenceSince = since;
    lastActivityAt = since;
    const resolved = withCtx(ctx);
    if (resolved && state.joined) flushRegistry(resolved, true);
  }

  function cancelScheduledIdle(): void {
    if (!idleTransitionTimer) return;
    clearTimeout(idleTransitionTimer);
    idleTransitionTimer = null;
  }

  function markWorking(ctx?: ExtensionContext | null): void {
    cancelScheduledIdle();
    const now = new Date().toISOString();
    lastActivityAt = now;
    if (state.presenceState !== "working") {
      setPresence("working", ctx, now);
      return;
    }
    const resolved = withCtx(ctx);
    if (resolved && state.joined) flushRegistry(resolved, false);
  }

  function markIdle(ctx?: ExtensionContext | null): void {
    cancelScheduledIdle();
    const now = new Date().toISOString();
    lastActivityAt = now;
    if (state.presenceState !== "idle") {
      setPresence("idle", ctx, now);
      return;
    }
    const resolved = withCtx(ctx);
    if (resolved && state.joined) flushRegistry(resolved, true);
  }

  function scheduleIdle(ctx?: ExtensionContext | null): void {
    cancelScheduledIdle();
    const scheduledCtx = withCtx(ctx);
    idleTransitionTimer = setTimeout(() => {
      idleTransitionTimer = null;
      markIdle(scheduledCtx);
    }, WORKING_TO_IDLE_GRACE_MS);
  }

  function presenceLabel(agent: AgentRegistration, now = Date.now()): { label: string; elapsedMs: number } {
    const since = Date.parse(agent.presenceSince ?? agent.lastActivityAt ?? agent.joinedAt ?? new Date().toISOString());
    const elapsedMs = Math.max(0, now - since);
    const label = agent.presenceState === "working"
      ? `working ${formatDuration(elapsedMs)}`
      : `idle ${formatDuration(elapsedMs)}`;
    return { label, elapsedMs };
  }

  function targetKey(target: IdleWatchTarget): string {
    return target.kind === "agent" ? `agent:${target.name.toLowerCase()}` : `role:${target.role.toLowerCase()}`;
  }

  function presenceRuleKey(watchFor: PresenceState, target: IdleWatchTarget): string {
    return `${watchFor}:${targetKey(target)}`;
  }

  function matchesTarget(target: IdleWatchTarget, agent: AgentRegistration): boolean {
    return target.kind === "agent"
      ? agent.name.toLowerCase() === target.name.toLowerCase()
      : agent.role.toLowerCase() === target.role.toLowerCase();
  }

  function suggestedAgentName(): string {
    if (state.agentName && !isNameTaken(state.project, state.agentName, state.sessionId)) return state.agentName;
    const excluded = readActiveAgents(state.project).map((agent) => agent.name);
    return generateAgentName(excluded);
  }

  function currentRegistration(ctx: ExtensionContext): AgentRegistration {
    refreshProject(ctx.cwd ?? process.cwd());
    return {
      version: 1,
      sessionId: state.sessionId,
      name: state.agentName,
      role: state.agentRole,
      pid: process.pid,
      joinedAt,
      updatedAt: new Date().toISOString(),
      lastActivityAt,
      cwd: ctx.cwd ?? process.cwd(),
      model: state.currentModel,
      branch: state.project.branch,
      isHuman: ctx.hasUI,
      projectKey: state.project.key,
      projectLabel: state.project.label,
      presenceState: state.presenceState,
      presenceSince: state.presenceSince,
    };
  }

  function updateStatusLine(ctx?: ExtensionContext | null): void {
    const resolved = withCtx(ctx);
    if (!resolved?.hasUI) return;

    if (!state.joined) {
      resolved.ui.setStatus("messenger", undefined);
      return;
    }

    const otherAgents = readActiveAgents(state.project).filter((agent) => agent.sessionId !== state.sessionId).length;
    const presenceStart = Date.parse(state.presenceSince);
    const presence = `${state.presenceState} ${formatDuration(Math.max(0, Date.now() - (Number.isFinite(presenceStart) ? presenceStart : Date.now())))}`;
    const bits = [`messenger: ${state.agentName} (${state.agentRole})`, `${otherAgents} agent${otherAgents === 1 ? "" : "s"}`, presence];
    resolved.ui.setStatus("messenger", resolved.ui.theme.fg("accent", bits.join(" • ")));
  }

  function flushRegistry(ctx: ExtensionContext, force = false): void {
    if (!state.joined) return;
    const now = Date.now();
    if (!force && now - state.lastRegistryWriteAt < 700) return;
    const registration = currentRegistration(ctx);

    try {
      writeRegistry(state.project, registration);
      state.lastRegistryWriteAt = now;
      updateStatusLine(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI && now - lastRegistryWriteErrorAt > 30_000) {
        lastRegistryWriteErrorAt = now;
        ctx.ui.notify(`Messenger registry update failed; will retry. (${message})`, "warning");
      }
    }
  }

  function noteActivity(ctx?: ExtensionContext | null, force = false): void {
    const resolved = withCtx(ctx);
    lastActivityAt = new Date().toISOString();
    if (resolved && state.joined) flushRegistry(resolved, force);
  }

  function ensureJoined(ctx: ExtensionContext) {
    latestCtx = ctx;
    refreshProject(ctx.cwd ?? process.cwd());
    if (state.joined) return null;
    return result(
      "Not joined. Use messenger({ action: \"join\" }) first.",
      { mode: "error", error: "not_joined" },
    );
  }

  function listMyPresenceWatchRules(watchFor?: PresenceState): IdleWatchRule[] {
    if (!state.agentName) return [];
    return watchStore.rules.filter((rule) => rule.projectKey === state.project.key && rule.watcherName.toLowerCase() === state.agentName.toLowerCase() && (!watchFor || rule.watchFor === watchFor));
  }

  function upsertIdleWatchRule(rule: IdleWatchRule): IdleWatchRule {
    const idx = watchStore.rules.findIndex((existing) => existing.id === rule.id);
    if (idx >= 0) watchStore.rules[idx] = rule;
    else watchStore.rules.push(rule);
    savePrivateWatchStore();
    return rule;
  }

  function removeIdleWatchRule(id: string): boolean {
    const before = watchStore.rules.length;
    watchStore.rules = watchStore.rules.filter((rule) => rule.id !== id);
    const changed = watchStore.rules.length !== before;
    if (changed) savePrivateWatchStore();
    return changed;
  }

  function getThreads(): ThreadSummary[] {
    return buildThreads(state.project, state.sessionId, currentNamesMap(), currentRolesMap());
  }

  function buildInjectedMessengerText(message: Pick<ChatMessage, "kind" | "fromNameSnapshot" | "fromRoleSnapshot" | "replyTo" | "text">): string {
    const isBroadcast = message.kind === "broadcast";
    const tag = isBroadcast ? "global_messenger_broadcast" : "direct_messenger_message";
    const replyTag = message.replyTo ? `\n  <reply_to>${message.replyTo}</reply_to>` : "";
    return `<${tag}>\n  <sender>${message.fromNameSnapshot}</sender>\n  <role>${message.fromRoleSnapshot}</role>\n  <note>To reply, use the messenger tool.</note>${replyTag}\n  <contents>\n${message.text}\n  </contents>\n</${tag}>`;
  }

  function buildInjectedMessengerBatchText(messages: ChatMessage[]): string {
    const sorted = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const rendered = sorted.map((message, index) => {
      const isBroadcast = message.kind === "broadcast";
      const tag = isBroadcast ? "global_messenger_broadcast" : "direct_messenger_message";
      const replyTag = message.replyTo ? `\n    <reply_to>${message.replyTo}</reply_to>` : "";
      return `  <pending_message index="${index + 1}" of="${sorted.length}">\n    <type>${tag}</type>\n    <sender>${message.fromNameSnapshot}</sender>\n    <role>${message.fromRoleSnapshot}</role>\n    <created_at>${message.createdAt}</created_at>${replyTag}\n    <contents>\n${message.text}\n    </contents>\n  </pending_message>`;
    }).join("\n\n");
    return `<messenger_pending_messages>\n  <note>You had ${sorted.length} pending messenger messages. They are shown below from oldest to most recent. Handle each one separately. To reply, use the messenger tool.</note>\n${rendered}\n</messenger_pending_messages>`;
  }

  function finishResetRequest(request: ResetContextBeforeMessageRequest, payload: Omit<ResetContextBeforeMessageResult, "version" | "controlType" | "createdAt">) {
    writeResetContextBeforeMessageResult(state.project, request.senderSessionId, {
      version: 1,
      controlType: "reset_context_before_message_result",
      createdAt: new Date().toISOString(),
      ...payload,
    });
  }

  function applyResetRequest(ctx: ExtensionContext, request: ResetContextBeforeMessageRequest): void {
    latestCtx = ctx;
    refreshProject(ctx.cwd ?? process.cwd());

    if (!state.joined) {
      finishResetRequest(request, {
        requestId: request.requestId,
        recipientSessionId: state.sessionId,
        recipientNameSnapshot: state.agentName,
        ok: false,
        error: "not_joined",
        message: "Recipient is no longer joined to messenger.",
      });
      return;
    }

    if (request.recipientSessionId !== state.sessionId) {
      finishResetRequest(request, {
        requestId: request.requestId,
        recipientSessionId: state.sessionId,
        recipientNameSnapshot: state.agentName,
        ok: false,
        error: "failed",
        message: "Reset request reached the wrong recipient session.",
      });
      return;
    }

    const sessionManager = ctx.sessionManager as unknown as { resetLeaf?: () => void };
    if (typeof sessionManager.resetLeaf !== "function") {
      finishResetRequest(request, {
        requestId: request.requestId,
        recipientSessionId: state.sessionId,
        recipientNameSnapshot: state.agentName,
        ok: false,
        error: "failed",
        message: "This Pi runtime does not expose resetLeaf().",
      });
      return;
    }

    try {
      sessionManager.resetLeaf();
      pi.sendUserMessage(buildInjectedMessengerText({
        kind: request.deliveryKind,
        fromNameSnapshot: request.senderNameSnapshot,
        fromRoleSnapshot: request.senderRoleSnapshot,
        replyTo: request.replyTo,
        text: request.text,
      }));
      finishResetRequest(request, {
        requestId: request.requestId,
        recipientSessionId: state.sessionId,
        recipientNameSnapshot: state.agentName,
        ok: true,
        message: `Context wiped for ${state.agentName}; message delivered as first prompt of a new root branch.`,
      });
    } catch (error) {
      finishResetRequest(request, {
        requestId: request.requestId,
        recipientSessionId: state.sessionId,
        recipientNameSnapshot: state.agentName,
        ok: false,
        error: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function renderIncomingMessage(message: ChatMessage): void {
    const isBroadcast = message.kind === "broadcast";
    const displayType = isBroadcast
      ? `Broadcast from agent ${message.fromNameSnapshot} (${message.fromRoleSnapshot})`
      : `Message from agent ${message.fromNameSnapshot} (${message.fromRoleSnapshot})`;
    const rawInjectedText = buildInjectedMessengerText(message);

    pi.sendMessage(
      {
        customType: "messenger_message",
        content: rawInjectedText,
        display: true,
        details: {
          kind: message.kind,
          from: message.fromNameSnapshot,
          fromRole: message.fromRoleSnapshot,
          replyTo: message.replyTo,
          title: displayType,
          createdAt: message.createdAt,
          rawMessageText: message.text,
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  }

  function renderIncomingMessageBatch(messages: ChatMessage[]): void {
    if (messages.length === 1) {
      renderIncomingMessage(messages[0]!);
      return;
    }

    pi.sendMessage(
      {
        customType: "messenger_message_batch",
        content: buildInjectedMessengerBatchText(messages),
        display: true,
        details: {
          title: `${messages.length} pending messenger messages`,
          count: messages.length,
          ordered: "oldest_to_most_recent",
          messages: messages.map((message) => ({
            kind: message.kind,
            from: message.fromNameSnapshot,
            fromRole: message.fromRoleSnapshot,
            replyTo: message.replyTo,
            createdAt: message.createdAt,
            rawMessageText: message.text,
          })),
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  }

  function scanIdleWarnings(ctx?: ExtensionContext | null): void {
    const resolved = withCtx(ctx);
    if (!state.joined || !state.agentName || !resolved || !canTriggerAgentFromPoll(resolved)) return;
    const myRules = listMyPresenceWatchRules();
    if (myRules.length === 0) return;

    const agents = readActiveAgents(state.project);
    const now = Date.now();
    let changed = false;
    let sentAlert = false;

    for (const rule of myRules) {
      if (sentAlert) break;
      if (!rule.enabled) continue;

      for (const agent of agents) {
        if (agent.sessionId === state.sessionId) continue;
        if (!matchesTarget(rule.target, agent)) continue;

        const key = agent.name.toLowerCase();
        const since = Date.parse(agent.presenceSince ?? agent.lastActivityAt ?? agent.joinedAt);
        const idleMs = Math.max(0, now - since);
        const thresholdMs = Math.max(0, rule.afterMinutes) * 60_000;
        const watchMatches = rule.watchFor === "working" ? agent.presenceState === "working" : agent.presenceState !== "working";
        const currentMultiple = thresholdMs > 0 ? Math.floor(idleMs / thresholdMs) : 0;
        const allowedMultiples = new Set([1, 2, 3, 5]);
        const sentMultiples = (() => {
          const raw = rule.notifiedTargets[key];
          if (!raw) return new Set<number>();
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) return new Set(parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n)));
          } catch {}
          return new Set<number>();
        })();

        if (!watchMatches || idleMs < thresholdMs) {
          if (rule.notifiedTargets[key]) {
            delete rule.notifiedTargets[key];
            changed = true;
          }
          continue;
        }

        if (!allowedMultiples.has(currentMultiple) || sentMultiples.has(currentMultiple)) continue;

        const idleFor = formatDuration(idleMs);
        const targetDesc = rule.target.kind === "agent" ? `agent ${agent.name}` : `role ${rule.target.role}`;
        const alertText = rule.watchFor === "working"
          ? `⚠️ ${agent.name} has been working nonstop for ${idleFor}. You may want to ask what's up, whether they're blocked, or whether they're still making good progress. (${targetDesc}; threshold ${rule.afterMinutes}m × ${currentMultiple}).`
          : `⚠️ ${agent.name} has been idle for ${idleFor}. This means he's currently not working on anything. You may want to wake him up with a message and ask him what's up. (${targetDesc}; threshold ${rule.afterMinutes}m × ${currentMultiple}).`;

        pi.sendMessage(
          {
            customType: "messenger_idle_alert",
            content: alertText,
            display: true,
            details: {
              ruleId: rule.id,
              targetKind: rule.target.kind,
              targetName: agent.name,
              targetRole: agent.role,
              afterMinutes: rule.afterMinutes,
              idleFor,
              watchFor: rule.watchFor,
              repeatMultiple: currentMultiple,
              projectKey: state.project.key,
            },
          },
          {
            deliverAs: "followUp",
            triggerTurn: true,
          },
        );

        sentMultiples.add(currentMultiple);
        rule.notifiedTargets[key] = JSON.stringify([...sentMultiples].sort((a, b) => a - b));
        changed = true;
        sentAlert = true;
        break;
      }
    }

    if (changed) savePrivateWatchStore();
  }

  function pollInbox(): void {
    const ctx = latestCtx;
    if (!ctx || !state.joined) return;

    refreshProject(ctx.cwd ?? process.cwd());

    const canDeliverAgentMessage = canTriggerAgentFromPoll(ctx);
    let deliveredAgentMessage = false;
    const items = consumeInbox(state.project, state.sessionId);
    for (const entry of items) {
      const item = entry.item;

      if ("controlType" in item && item.controlType === "reset_context_before_message") {
        if (!canDeliverAgentMessage) {
          writeResetContextBeforeMessageResult(state.project, item.senderSessionId, {
            version: 1,
            controlType: "reset_context_before_message_result",
            requestId: item.requestId,
            recipientSessionId: state.sessionId,
            recipientNameSnapshot: state.agentName,
            ok: false,
            error: "busy",
            message: `${state.agentName} is busy right now.`,
            createdAt: new Date().toISOString(),
          });
          removeInboxMessage(entry.path);
          continue;
        }

        applyResetRequest(ctx, item);
        removeInboxMessage(entry.path);
        deliveredAgentMessage = true;
        break;
      }

      if (!canDeliverAgentMessage) break;

      const batch: { message: ChatMessage; path: string }[] = [];
      for (const candidate of items) {
        if ("controlType" in candidate.item) {
          if (batch.length === 0) continue;
          break;
        }
        batch.push({ message: candidate.item as ChatMessage, path: candidate.path });
        if (batch.length >= 5) break;
      }

      renderIncomingMessageBatch(batch.map((candidate) => candidate.message));
      for (const candidate of batch) removeInboxMessage(candidate.path);
      deliveredAgentMessage = true;
      break;
    }

    if (Date.now() - state.lastRegistryWriteAt > config.heartbeatIntervalMs) {
      flushRegistry(ctx, true);
    }
    if (!deliveredAgentMessage) scanIdleWarnings(ctx);
    updateStatusLine(ctx);
  }

  function startPolling(): void {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(pollInbox, config.inboxPollIntervalMs);
  }

  function stopPolling(): void {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    cancelScheduledIdle();
  }

  function doJoin(ctx: ExtensionContext, requestedName?: string, requestedRole?: string) {
    latestCtx = ctx;
    refreshProject(ctx.cwd ?? process.cwd());
    ensureProjectDirs(state.project);

    if (state.joined) {
      const otherAgents = readActiveAgents(state.project).filter((agent) => agent.sessionId !== state.sessionId);
      return result(
        `Already joined as ${state.agentName} (${state.agentRole}). ${otherAgents.length} other agent${otherAgents.length === 1 ? "" : "s"} active.`,
        { mode: "join", alreadyJoined: true, name: state.agentName, role: state.agentRole, agentCount: otherAgents.length },
      );
    }

    const nextName = (requestedName ?? state.agentName ?? "").trim() || suggestedAgentName();
    const nextRole = (requestedRole ?? state.agentRole ?? "").trim() || "agent";

    if (!nextName) {
      return result("Error: name is required.", { mode: "join", error: "missing_name" });
    }
    if (!nextRole) {
      return result("Error: role is required.", { mode: "join", error: "missing_role" });
    }
    if (isNameTaken(state.project, nextName, state.sessionId)) {
      return result(`Name already in use: ${nextName}`, { mode: "join", error: "name_taken" });
    }

    state.agentName = nextName;
    state.agentRole = nextRole;
    loadPrivateWatchStore();

    ensureInbox(state.project, state.sessionId);
    joinedAt = new Date().toISOString();
    lastActivityAt = joinedAt;
    state.presenceState = "idle";
    state.presenceSince = joinedAt;
    state.lastRegistryWriteAt = 0;
    state.joined = true;
    flushRegistry(ctx, true);
    startPolling();
    updateStatusLine(ctx);

    const otherAgents = readActiveAgents(state.project).filter((agent) => agent.sessionId !== state.sessionId);
    return result(
      `Joined as ${state.agentName} (${state.agentRole}) in ${state.project.label}. ${otherAgents.length} other agent${otherAgents.length === 1 ? "" : "s"} active.`,
      {
        mode: "join",
        name: state.agentName,
        role: state.agentRole,
        project: state.project.label,
        agentCount: otherAgents.length,
        agents: otherAgents.map((agent) => agent.name),
      },
    );
  }

  function doLeave(ctx: ExtensionContext) {
    latestCtx = ctx;
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;

    stopPolling();
    state.joined = false;
    removeRegistry(state.project, state.sessionId);
    cleanupInbox(state.project, state.sessionId);

    updateStatusLine(ctx);

    return result(`Left messenger as ${state.agentName} (${state.agentRole}).`, {
      mode: "leave",
      name: state.agentName,
      role: state.agentRole,
    });
  }

  function executeStatus(ctx: ExtensionContext) {
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;

    const agents = readActiveAgents(state.project);
    const self = agents.find((agent) => agent.sessionId === state.sessionId);
    const otherAgents = agents.filter((agent) => agent.sessionId !== state.sessionId);
    let text = `# Messenger status (${agents.length} online — project: ${state.project.label})\n\n`;
    if (self) {
      const selfPresence = presenceLabel(self);
      text += `• ${self.name} (you, ${self.role}) — ${selfPresence.label} — ${self.branch ?? "unknown"} — ${self.model ?? "unknown"}\n`;
    }
    if (otherAgents.length === 0) {
      text += `No other agents online.`;
    } else {
      text += otherAgents.map((agent) => {
        const presence = presenceLabel(agent);
        const badges = [presence.label].filter(Boolean).join(" • ");
        return `• ${agent.name} (${agent.role}) — ${badges}${agent.branch ? ` — ${agent.branch}` : ""}${agent.model ? ` — ${agent.model}` : ""}`;
      }).join("\n");
    }

    return result(text, {
      mode: "status",
      agents,
    });
  }

  function resolveRecipients(to: string | string[] | undefined) {
    if (!to) return { error: "missing_recipient", text: "Error: 'to' is required." } as const;

    let wanted: string[] = [];
    let decodedFromString = false;

    if (Array.isArray(to)) {
      wanted = to;
    } else {
      const raw = to.trim();
      if (raw.length === 0) {
        return { error: "missing_recipient", text: "Error: 'to' is required." } as const;
      }

      if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === "string") {
            wanted = [parsed];
            decodedFromString = true;
          } else if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
            wanted = parsed;
            decodedFromString = true;
          } else {
            wanted = [raw];
          }
        } catch {
          wanted = [raw];
        }
      } else {
        wanted = [raw];
      }
    }

    wanted = wanted.map((name) => name.trim()).filter((name) => name.length > 0);

    const recipients: AgentRegistration[] = [];
    const failed: string[] = [];

    for (const name of wanted) {
      const agent = getAgentByName(state.project, name);
      if (!agent) {
        failed.push(name);
        continue;
      }
      if (agent.sessionId === state.sessionId) {
        failed.push(name);
        continue;
      }
      recipients.push(agent);
    }

    if (recipients.length === 0) {
      const onlineAgents = readActiveAgents(state.project)
        .filter((agent) => agent.sessionId !== state.sessionId)
        .map((agent) => agent.name);
      const onlineText = onlineAgents.length > 0
        ? `\nCurrently online agents: ${onlineAgents.join(", ")}`
        : "\nCurrently online agents: none";
      const exampleText = "\nExamples:\n- messenger({ action: \"send\", to: \"EchoHill\", message: \"...\" })\n- messenger({ action: \"send\", to: [\"EchoHill\", \"CometFalcon\"], message: \"...\" })";
      const decodeText = decodedFromString
        ? "\nNote: your 'to' value looked JSON-encoded. Pass names directly as a string or array, not as a quoted JSON string."
        : "";
      return {
        error: "no_recipients",
        text: `${failed.length > 0
          ? `No valid recipients. Missing or invalid: ${failed.join(", ")}`
          : "No valid recipients."}${decodeText}${onlineText}${exampleText}`,
      } as const;
    }

    return { recipients, failed } as const;
  }

  async function waitForResetResults(requestIds: string[], timeoutMs = 15_000): Promise<Map<string, ResetContextBeforeMessageResult>> {
    const results = new Map<string, ResetContextBeforeMessageResult>();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && results.size < requestIds.length) {
      for (const requestId of requestIds) {
        if (results.has(requestId)) continue;
        const result = readResetContextBeforeMessageResult(state.project, state.sessionId, requestId);
        if (!result) continue;
        results.set(requestId, result);
        removeResetContextBeforeMessageResult(state.project, state.sessionId, requestId);
      }

      if (results.size >= requestIds.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return results;
  }

  async function sendDirectMessage(ctx: ExtensionContext, to: string | string[] | undefined, text: string | undefined, replyTo?: string, resetContextBeforeMessage = false) {
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    if (!text?.trim()) return result("Error: message is required.", { mode: "send", error: "missing_message" });

    const resolved = resolveRecipients(to);
    if ("error" in resolved) return result(String(resolved.text ?? "No valid recipients."), { mode: "send", error: resolved.error });

    const rawText = text.trim();
    if (!resetContextBeforeMessage) {
      const deliveredTo: string[] = [];
      for (const recipient of resolved.recipients) {
        const message: ChatMessage = {
          version: 1,
          id: randomUUID(),
          kind: "direct",
          fromSessionId: state.sessionId,
          fromNameSnapshot: state.agentName,
          fromRoleSnapshot: state.agentRole,
          fromIsHuman: ctx.hasUI,
          toSessionIds: [recipient.sessionId],
          toNameSnapshots: [recipient.name],
          text: rawText,
          replyTo,
          createdAt: new Date().toISOString(),
        };
        appendMessage(state.project, message, config.messageRetention);
        enqueueInboxMessage(state.project, recipient.sessionId, message);
        deliveredTo.push(recipient.name);
      }

      noteActivity(ctx, true);

      const failedText = resolved.failed.length > 0 ? ` Failed: ${resolved.failed.join(", ")}.` : "";
      const replyText = replyTo ? `\nReplyTo: ${replyTo}` : "";
      return result(`Sent to ${deliveredTo.join(", ")}.${failedText}\n\nRaw message:${replyText}\n${rawText}`, {
        mode: "send",
        recipients: deliveredTo,
        failed: resolved.failed,
        rawMessageText: rawText,
        replyTo,
      });
    }

    const requests = resolved.recipients.map((recipient) => ({
      recipient,
      request: {
        version: 1 as const,
        controlType: "reset_context_before_message" as const,
        requestId: randomUUID(),
        deliveryKind: "direct" as const,
        senderSessionId: state.sessionId,
        senderNameSnapshot: state.agentName,
        senderRoleSnapshot: state.agentRole,
        senderIsHuman: ctx.hasUI,
        recipientSessionId: recipient.sessionId,
        recipientNameSnapshot: recipient.name,
        text: rawText,
        replyTo,
        createdAt: new Date().toISOString(),
      },
    }));

    for (const entry of requests) enqueueInboxMessage(state.project, entry.recipient.sessionId, entry.request);

    const results = await waitForResetResults(requests.map((entry) => entry.request.requestId));
    const deliveredTo: string[] = [];
    const failedTargets: string[] = [...resolved.failed];
    const timedOutTargets: string[] = [];

    for (const entry of requests) {
      const outcome = results.get(entry.request.requestId);
      if (!outcome) {
        timedOutTargets.push(entry.recipient.name);
        continue;
      }
      if (!outcome.ok) {
        failedTargets.push(`${entry.recipient.name} (${outcome.error ?? "failed"})`);
        continue;
      }

      appendMessage(state.project, {
        version: 1,
        id: randomUUID(),
        kind: "direct",
        fromSessionId: state.sessionId,
        fromNameSnapshot: state.agentName,
        fromRoleSnapshot: state.agentRole,
        fromIsHuman: ctx.hasUI,
        toSessionIds: [entry.recipient.sessionId],
        toNameSnapshots: [entry.recipient.name],
        text: rawText,
        replyTo,
        createdAt: new Date().toISOString(),
      }, config.messageRetention);
      deliveredTo.push(entry.recipient.name);
    }

    noteActivity(ctx, true);

    const replyText = replyTo ? `\nReplyTo: ${replyTo}` : "";
    let textResult = deliveredTo.length > 0
      ? `Context wiped, then sent to ${deliveredTo.join(", ")}.`
      : "No recipient context was wiped; message was not delivered.";
    if (failedTargets.length > 0) textResult += `\nFailed: ${failedTargets.join(", ")}.`;
    if (timedOutTargets.length > 0) textResult += `\nTimed out waiting for: ${timedOutTargets.join(", ")}.`;
    textResult += `\n\nRaw message:${replyText}\n${rawText}`;

    return result(textResult, {
      mode: "send",
      recipients: deliveredTo,
      failed: failedTargets,
      timedOut: timedOutTargets,
      rawMessageText: rawText,
      replyTo,
      completely_wipe_recipient_context_before_message: true,
    });
  }

  async function sendBroadcast(ctx: ExtensionContext, text: string | undefined, replyTo?: string, resetContextBeforeMessage = false) {
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    if (!text?.trim()) return result("Error: message is required.", { mode: "broadcast", error: "missing_message" });

    const recipients = readActiveAgents(state.project).filter((agent) => agent.sessionId !== state.sessionId);
    const rawText = text.trim();

    if (!resetContextBeforeMessage) {
      const message: ChatMessage = {
        version: 1,
        id: randomUUID(),
        kind: "broadcast",
        fromSessionId: state.sessionId,
        fromNameSnapshot: state.agentName,
        fromRoleSnapshot: state.agentRole,
        fromIsHuman: ctx.hasUI,
        toSessionIds: recipients.map((agent) => agent.sessionId),
        toNameSnapshots: recipients.map((agent) => agent.name),
        text: rawText,
        replyTo,
        createdAt: new Date().toISOString(),
      };

      appendMessage(state.project, message, config.messageRetention);
      for (const recipient of recipients) enqueueInboxMessage(state.project, recipient.sessionId, message);

      noteActivity(ctx, true);
      const replyText = replyTo ? `\nReplyTo: ${replyTo}` : "";
      return result(
        `Broadcast sent to ${recipients.length} agent${recipients.length === 1 ? "" : "s"}.\n\nRaw message:${replyText}\n${rawText}`,
        { mode: "broadcast", recipientCount: recipients.length, rawMessageText: rawText, replyTo },
      );
    }

    const requests = recipients.map((recipient) => ({
      recipient,
      request: {
        version: 1 as const,
        controlType: "reset_context_before_message" as const,
        requestId: randomUUID(),
        deliveryKind: "broadcast" as const,
        senderSessionId: state.sessionId,
        senderNameSnapshot: state.agentName,
        senderRoleSnapshot: state.agentRole,
        senderIsHuman: ctx.hasUI,
        recipientSessionId: recipient.sessionId,
        recipientNameSnapshot: recipient.name,
        text: rawText,
        replyTo,
        createdAt: new Date().toISOString(),
      },
    }));

    for (const entry of requests) enqueueInboxMessage(state.project, entry.recipient.sessionId, entry.request);

    const results = await waitForResetResults(requests.map((entry) => entry.request.requestId));
    const deliveredRecipients = requests.filter((entry) => results.get(entry.request.requestId)?.ok);
    const failedTargets = requests
      .filter((entry) => {
        const outcome = results.get(entry.request.requestId);
        return outcome && !outcome.ok;
      })
      .map((entry) => `${entry.recipient.name} (${results.get(entry.request.requestId)?.error ?? "failed"})`);
    const timedOutTargets = requests
      .filter((entry) => !results.has(entry.request.requestId))
      .map((entry) => entry.recipient.name);

    if (deliveredRecipients.length > 0) {
      appendMessage(state.project, {
        version: 1,
        id: randomUUID(),
        kind: "broadcast",
        fromSessionId: state.sessionId,
        fromNameSnapshot: state.agentName,
        fromRoleSnapshot: state.agentRole,
        fromIsHuman: ctx.hasUI,
        toSessionIds: deliveredRecipients.map((entry) => entry.recipient.sessionId),
        toNameSnapshots: deliveredRecipients.map((entry) => entry.recipient.name),
        text: rawText,
        replyTo,
        createdAt: new Date().toISOString(),
      }, config.messageRetention);
    }

    noteActivity(ctx, true);
    const replyText = replyTo ? `\nReplyTo: ${replyTo}` : "";
    let textResult = deliveredRecipients.length > 0
      ? `Context wiped, then broadcast sent to ${deliveredRecipients.length} agent${deliveredRecipients.length === 1 ? "" : "s"}: ${deliveredRecipients.map((entry) => entry.recipient.name).join(", ")}.`
      : "No recipient context was wiped; broadcast was not delivered.";
    if (failedTargets.length > 0) textResult += `\nFailed: ${failedTargets.join(", ")}.`;
    if (timedOutTargets.length > 0) textResult += `\nTimed out waiting for: ${timedOutTargets.join(", ")}.`;
    textResult += `\n\nRaw message:${replyText}\n${rawText}`;

    return result(textResult, {
      mode: "broadcast",
      recipientCount: deliveredRecipients.length,
      recipients: deliveredRecipients.map((entry) => entry.recipient.name),
      failed: failedTargets,
      timedOut: timedOutTargets,
      rawMessageText: rawText,
      replyTo,
      completely_wipe_recipient_context_before_message: true,
    });
  }

  function executeRename(ctx: ExtensionContext, nextName?: string) {
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    const trimmed = nextName?.trim();
    if (!trimmed) return result("Error: name is required.", { mode: "rename", error: "missing_name" });
    if (trimmed.toLowerCase() === state.agentName.toLowerCase()) {
      return result(`Already using ${state.agentName}.`, { mode: "rename", unchanged: true });
    }
    if (isNameTaken(state.project, trimmed, state.sessionId)) {
      return result(`Name already in use: ${trimmed}`, { mode: "rename", error: "name_taken" });
    }

    const oldName = state.agentName;
    state.agentName = trimmed;
    watchStore.rules = watchStore.rules.map((rule) => rule.watcherName.toLowerCase() === oldName.toLowerCase() ? { ...rule, watcherName: trimmed } : rule);
    savePrivateWatchStore();
    flushRegistry(ctx, true);
    return result(`Renamed from ${oldName} to ${trimmed}.`, {
      mode: "rename",
      oldName,
      newName: trimmed,
    });
  }

  function configurePresenceWarning(ctx: ExtensionContext, params: ToolParamsType, watchFor: PresenceState) {
    const actionName = watchFor === "working" ? "warn_me_when_working" : "warn_me_when_idle";
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    if (!state.agentName) return result("Error: join first so I know which private watch list to update.", { mode: actionName, error: "not_joined" });

    const targetName = params.targetName?.trim();
    const targetRole = params.targetRole?.trim();
    const afterMinutes = typeof params.minutes === "number" && Number.isFinite(params.minutes) ? params.minutes : NaN;

    if ((!targetName && !targetRole) || (targetName && targetRole)) {
      return result("Error: provide exactly one target: either targetName or targetRole.", { mode: actionName, error: "missing_target" });
    }
    if (!Number.isFinite(afterMinutes) || afterMinutes <= 0) {
      return result("Error: minutes must be a positive number.", { mode: actionName, error: "invalid_minutes" });
    }

    const target: IdleWatchTarget = targetName
      ? { kind: "agent", name: targetName }
      : { kind: "role", role: targetRole! };
    const rule: IdleWatchRule = {
      version: 1,
      id: params.id?.trim() || randomUUID(),
      projectKey: state.project.key,
      watcherName: state.agentName,
      enabled: params.enabled !== false,
      watchFor,
      target,
      afterMinutes,
      notifiedTargets: {},
    };

    const existingIdx = watchStore.rules.findIndex((existing) => existing.projectKey === state.project.key && existing.watcherName.toLowerCase() === state.agentName.toLowerCase() && presenceRuleKey(existing.watchFor, existing.target) === presenceRuleKey(watchFor, target));
    if (existingIdx >= 0) {
      rule.id = watchStore.rules[existingIdx].id;
      rule.notifiedTargets = watchStore.rules[existingIdx].notifiedTargets ?? {};
    }
    upsertIdleWatchRule(rule);

    const targetLabel = rule.target.kind === "agent" ? `agent ${rule.target.name}` : `role ${rule.target.role}`;
    const verb = watchFor === "working" ? "keeps working" : "stays idle";
    return result(`Will warn me when ${targetLabel} ${verb} for ${afterMinutes} minute${afterMinutes === 1 ? "" : "s"}.`, {
      mode: actionName,
      rule,
    });
  }

  function listPresenceWarnings(ctx: ExtensionContext, watchFor: PresenceState) {
    const actionName = watchFor === "working" ? "warn_me_when_working.list" : "warn_me_when_idle.list";
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;

    const rules = listMyPresenceWatchRules(watchFor);
    if (rules.length === 0) {
      return result(`No private ${watchFor} warning rules configured.`, { mode: actionName, rules: [] });
    }

    const lines = rules.map((rule) => {
      const targetLabel = rule.target.kind === "agent" ? `agent:${rule.target.name}` : `role:${rule.target.role}`;
      return `• ${rule.id} — ${targetLabel} — warn after ${rule.afterMinutes}m — ${rule.enabled ? "enabled" : "disabled"}`;
    });
    return result(`Private ${watchFor} warning rules for ${state.agentName}:\n${lines.join("\n")}`, {
      mode: actionName,
      rules,
    });
  }

  function removePresenceWarning(ctx: ExtensionContext, id: string | undefined, watchFor: PresenceState) {
    const actionName = watchFor === "working" ? "warn_me_when_working.remove" : "warn_me_when_idle.remove";
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    const trimmed = id?.trim();
    if (!trimmed) return result("Error: rule id is required.", { mode: actionName, error: "missing_id" });

    const changed = removeIdleWatchRule(trimmed);
    return result(changed ? `Removed ${watchFor} warning rule ${trimmed}.` : `No ${watchFor} warning rule found with id ${trimmed}.`, {
      mode: actionName,
      removed: changed,
      id: trimmed,
    });
  }

  function clearPresenceWarnings(ctx: ExtensionContext, watchFor: PresenceState) {
    const actionName = watchFor === "working" ? "warn_me_when_working.clear" : "warn_me_when_idle.clear";
    const notJoined = ensureJoined(ctx);
    if (notJoined) return notJoined;
    const before = listMyPresenceWatchRules(watchFor).length;
    watchStore.rules = watchStore.rules.filter((rule) => !(rule.projectKey === state.project.key && rule.watcherName.toLowerCase() === state.agentName.toLowerCase() && rule.watchFor === watchFor));
    savePrivateWatchStore();
    return result(`Cleared ${before} private ${watchFor} warning rule${before === 1 ? "" : "s"}.`, {
      mode: actionName,
      cleared: before,
    });
  }

  function autoJoinIfConfigured(ctx: ExtensionContext): void {
    latestCtx = ctx;
    refreshProject(ctx.cwd ?? process.cwd());
    const shouldJoin = config.autoJoin || matchesPathPattern(ctx.cwd ?? process.cwd(), config.autoJoinPaths);
    if (shouldJoin && !state.joined) {
      ensureMessengerToolRegistered();
      doJoin(ctx);
    }
  }

  pi.registerMessageRenderer("messenger_message", (message, _options, theme) => {
    const details = (message.details ?? {}) as {
      title?: string;
      from?: string;
      fromRole?: string;
      replyTo?: string;
      createdAt?: string;
    };
    const labelColor = "accent";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const heading = details.title ?? `Message from agent ${details.from ?? "unknown"}${details.fromRole ? ` (${details.fromRole})` : ""}`;
    const meta = [
      theme.fg(labelColor, heading),
      details.createdAt ? theme.fg("dim", ` (${formatRelativeTime(details.createdAt)})`) : "",
      details.replyTo ? theme.fg("dim", `\n↳ reply to ${details.replyTo.slice(0, 8)}`) : "",
    ].join("");
    box.addChild(new Text(`${meta}\n${String(message.content)}`, 0, 0));
    return box;
  });

  pi.registerMessageRenderer("messenger_idle_alert", (message, _options, theme) => {
    const details = (message.details ?? {}) as { targetName?: string; targetRole?: string; idleFor?: string; afterMinutes?: number; watchFor?: PresenceState };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const watchFor = details.watchFor === "working" ? "working" : "idle";
    const heading = `${watchFor === "working" ? "Working-time warning" : "Idle warning"}${details.targetName ? ` — ${details.targetName}` : ""}${details.targetRole ? ` (${details.targetRole})` : ""}`;
    const meta = theme.fg("warning", heading);
    const body = theme.fg("dim", details.idleFor ? `${watchFor} for ${details.idleFor} · threshold ${details.afterMinutes}m` : String(message.content));
    box.addChild(new Text(`${meta}\n${body}\n${String(message.content)}`, 0, 0));
    return box;
  });

  function ensureMessengerToolRegistered(): void {
    if (messengerToolRegistered) return;
    messengerToolRegistered = true;

    pi.registerTool({
      name: "messenger",
      label: "Messenger",
      description: "Project-scoped messaging, agent presence, and private presence warnings.",
      parameters: ToolParams,
      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        latestCtx = ctx;
        state.currentModel = modelLabel(ctx);
        refreshProject(ctx.cwd ?? process.cwd());

        const params = rawParams as ToolParamsType;
        const action = params.action ?? "status";

        switch (action) {
          case "join": return doJoin(ctx);
          case "leave": return doLeave(ctx);
          case "status": return executeStatus(ctx);
          case "send": return sendDirectMessage(ctx, params.to, params.message, params.replyTo, params.completely_wipe_recipient_context_before_message === true);
          case "broadcast": return sendBroadcast(ctx, params.message, params.replyTo, params.completely_wipe_recipient_context_before_message === true);
          case "rename": return executeRename(ctx, params.name);
          case "warn_me_when_idle": return configurePresenceWarning(ctx, params, "idle");
          case "warn_me_when_idle.list": return listPresenceWarnings(ctx, "idle");
          case "warn_me_when_idle.remove": return removePresenceWarning(ctx, params.id, "idle");
          case "warn_me_when_idle.clear": return clearPresenceWarnings(ctx, "idle");
          case "warn_me_when_working": return configurePresenceWarning(ctx, params, "working");
          case "warn_me_when_working.list": return listPresenceWarnings(ctx, "working");
          case "warn_me_when_working.remove": return removePresenceWarning(ctx, params.id, "working");
          case "warn_me_when_working.clear": return clearPresenceWarnings(ctx, "working");
          default:
            return result(`Unknown action: ${action}`, { mode: "error", error: "unknown_action", action });
        }
      },
    });
  }

  async function openMessengerUi(ctx: ExtensionContext): Promise<void> {
    ensureMessengerToolRegistered();
    latestCtx = ctx;
    state.currentModel = modelLabel(ctx);
    refreshProject(ctx.cwd ?? process.cwd());

    if (!ctx.hasUI) return;

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new MessengerPanel(tui, theme, {
        projectLabel: state.project.label,
        initialJoined: state.joined,
        initialName: suggestedAgentName(),
        initialRole: state.agentRole || "agent",
        selfName: () => state.agentName,
        selfRole: () => state.agentRole,
        getAgents: () => readActiveAgents(state.project),
        getThreads,
        sendDirect: async (targetSessionId, text, replyTo) => {
          const target = readActiveAgents(state.project).find((agent) => agent.sessionId === targetSessionId);
          if (!target) return { ok: false, message: "Target is no longer online." };
          const toolResult = await sendDirectMessage(ctx, target.name, text, replyTo);
          return { ok: !toolResult.details.error, message: String(toolResult.content[0]?.text ?? "Sent") };
        },
        sendBroadcast: async (text, replyTo) => {
          const toolResult = await sendBroadcast(ctx, text, replyTo);
          return { ok: !toolResult.details.error, message: String(toolResult.content[0]?.text ?? "Broadcast sent") };
        },
        join: (name, role) => {
          const toolResult = doJoin(ctx, name, role);
          return { ok: !toolResult.details.error, message: String(toolResult.content[0]?.text ?? "Joined") };
        },
        done: () => done(undefined),
      }),
    );
  }

  pi.registerCommand("messenger", {
    description: "Open messenger",
    handler: async (_args, ctx) => {
      await openMessengerUi(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    state.currentModel = modelLabel(ctx);
    refreshProject(ctx.cwd ?? process.cwd());
    if (state.agentName) loadPrivateWatchStore();
    autoJoinIfConfigured(ctx);
    updateStatusLine(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    latestCtx = ctx;
    compactionInProgress = true;
    pauseAgentTriggeredDelivery(COMPACTION_DELIVERY_FAILSAFE_MS);
    event.signal?.addEventListener("abort", () => {
      compactionInProgress = false;
      pauseAgentTriggeredDelivery(COMPACTION_DELIVERY_GRACE_MS);
    }, { once: true });
    markWorking(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    latestCtx = ctx;
    compactionInProgress = false;
    pauseAgentTriggeredDelivery(COMPACTION_DELIVERY_GRACE_MS);
    updateStatusLine(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    latestCtx = ctx;
    stopPolling();
    if (state.joined) {
      removeRegistry(state.project, state.sessionId);
      cleanupInbox(state.project, state.sessionId);
      state.joined = false;
    }
    updateStatusLine(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    latestCtx = ctx;
    state.currentModel = `${event.model.provider}/${event.model.id}`;
    if (state.joined) flushRegistry(ctx, true);
  });

  pi.on("input", async (_event, ctx) => {
    latestCtx = ctx;
    noteActivity(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    if (!state.joined) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n<messenger_identity>\n  <agent_name>${state.agentName}</agent_name>\n  <role>${state.agentRole}</role>\n</messenger_identity>`,
    };
  });

  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
    markWorking(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    latestCtx = ctx;
    scheduleIdle(ctx);
  });
}
