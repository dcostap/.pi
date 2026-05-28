export interface SimpleMessengerConfig {
  autoJoin: boolean;
  autoJoinPaths: string[];
  inboxPollIntervalMs: number;
  heartbeatIntervalMs: number;
  messageRetention: number;
}

export interface ProjectInfo {
  key: string;
  label: string;
  rootDir: string;
  scopePath: string;
  scopeKind: "git" | "cwd";
  branch?: string;
  gitDir?: string;
  gitCommonDir?: string;
  projectDir: string;
}

export type PresenceState = "working" | "idle";

export interface AgentRegistration {
  version: 1;
  sessionId: string;
  name: string;
  role: string;
  pid: number;
  joinedAt: string;
  updatedAt: string;
  lastActivityAt: string;
  presenceState?: PresenceState;
  presenceSince?: string;
  cwd: string;
  model?: string;
  branch?: string;
  isHuman: boolean;
  projectKey: string;
  projectLabel: string;
}

export interface ChatMessage {
  version: 1;
  id: string;
  kind: "direct" | "broadcast";
  fromSessionId: string;
  fromNameSnapshot: string;
  fromRoleSnapshot: string;
  fromIsHuman: boolean;
  toSessionIds: string[];
  toNameSnapshots: string[];
  text: string;
  replyTo?: string;
  createdAt: string;
}

export interface ResetContextBeforeMessageRequest {
  version: 1;
  controlType: "reset_context_before_message";
  requestId: string;
  deliveryKind: "direct" | "broadcast";
  senderSessionId: string;
  senderNameSnapshot: string;
  senderRoleSnapshot: string;
  senderIsHuman: boolean;
  recipientSessionId: string;
  recipientNameSnapshot: string;
  text: string;
  replyTo?: string;
  createdAt: string;
}

export interface ResetContextBeforeMessageResult {
  version: 1;
  controlType: "reset_context_before_message_result";
  requestId: string;
  recipientSessionId: string;
  recipientNameSnapshot: string;
  ok: boolean;
  error?: "busy" | "not_joined" | "failed" | "timeout";
  message: string;
  createdAt: string;
}

export type InboxItem = ChatMessage | ResetContextBeforeMessageRequest;

export interface ThreadSummary {
  peerSessionId: string;
  peerName: string;
  peerRole: string;
  lastAt: string;
  preview: string;
  messages: ChatMessage[];
}

export interface IdleWatchTargetAgent {
  kind: "agent";
  name: string;
}

export interface IdleWatchTargetRole {
  kind: "role";
  role: string;
}

export type IdleWatchTarget = IdleWatchTargetAgent | IdleWatchTargetRole;

export interface IdleWatchRule {
  version: 1;
  id: string;
  projectKey: string;
  watcherName: string;
  enabled: boolean;
  watchFor: PresenceState;
  target: IdleWatchTarget;
  afterMinutes: number;
  notifiedTargets: Record<string, string>;
}

export interface IdleWatchStore {
  version: 1;
  rules: IdleWatchRule[];
}

export interface RuntimeState {
  sessionId: string;
  joined: boolean;
  agentName: string;
  agentRole: string;
  latestCtxWithUi?: unknown;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastRegistryWriteAt: number;
  currentModel?: string;
  project: ProjectInfo;
  presenceState: PresenceState;
  presenceSince: string;
}
