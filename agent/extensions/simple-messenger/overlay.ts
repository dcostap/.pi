import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { AgentRegistration, ThreadSummary } from "./types.js";
import { formatRelativeTime } from "./storage.js";

type Mode = "setup" | "main";
type Tab = "agents" | "chats";
type SetupFocus = 0 | 1 | 2 | 3; // 0=name, 1=role, 2=join, 3=cancel

type ComposeState =
  | { kind: "direct"; targetSessionId: string; targetName: string; replyTo?: string }
  | { kind: "broadcast"; replyTo?: string };

interface MessengerPanelOptions {
  projectLabel: string;
  initialJoined: boolean;
  initialName: string;
  initialRole: string;
  selfName: () => string;
  selfRole: () => string;
  getAgents: () => AgentRegistration[];
  getThreads: () => ThreadSummary[];
  sendDirect: (targetSessionId: string, text: string, replyTo?: string) => Promise<{ ok: boolean; message: string }>;
  sendBroadcast: (text: string, replyTo?: string) => Promise<{ ok: boolean; message: string }>;
  join: (name: string, role: string) => { ok: boolean; message: string };
  done: () => void;
}

export class MessengerPanel implements Component, Focusable {
  private mode: Mode;
  private tab: Tab = "agents";
  private setupFocus: SetupFocus = 0;
  private selectedAgentIndex = 0;
  private selectedThreadIndex = 0;
  private composeState: ComposeState | null = null;
  private footerNote = "";
  private cachedWidth?: number;
  private cachedLines?: string[];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly editor: Editor;
  private readonly nameInput: Input;
  private readonly roleInput: Input;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.updateFocusTargets();
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: MessengerPanelOptions,
  ) {
    this.mode = options.initialJoined ? "main" : "setup";

    this.editor = new Editor(tui, {
      borderColor: (s) => this.theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => this.theme.fg("accent", t),
        selectedText: (t) => this.theme.fg("accent", t),
        description: (t) => this.theme.fg("muted", t),
        scrollInfo: (t) => this.theme.fg("dim", t),
        noMatch: (t) => this.theme.fg("warning", t),
      },
    });
    this.editor.onSubmit = async (value) => {
      const text = value.trim();
      if (!text || !this.composeState) {
        this.footerNote = this.theme.fg("warning", "Message is empty.");
        this.refresh();
        return;
      }

      this.footerNote = this.theme.fg("dim", "Sending...");
      this.refresh();

      const result = this.composeState.kind === "direct"
        ? await this.options.sendDirect(this.composeState.targetSessionId, text, this.composeState.replyTo)
        : await this.options.sendBroadcast(text, this.composeState.replyTo);

      this.footerNote = result.ok
        ? this.theme.fg("success", result.message)
        : this.theme.fg("error", result.message);

      if (result.ok) {
        this.editor.setText("");
        this.composeState = null;
      }
      this.refresh();
    };

    this.nameInput = new Input();
    this.nameInput.setValue(options.initialName);
    this.nameInput.onSubmit = () => {
      this.setupFocus = 1;
      this.updateFocusTargets();
      this.refresh();
    };

    this.roleInput = new Input();
    this.roleInput.setValue(options.initialRole);
    this.roleInput.onSubmit = () => {
      this.tryJoin();
    };

    this.refreshTimer = setInterval(() => this.tui.requestRender(), 1000);
    this.markCurrentThreadRead();
    this.updateFocusTargets();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private updateFocusTargets(): void {
    this.nameInput.focused = this._focused && this.mode === "setup" && this.setupFocus === 0;
    this.roleInput.focused = this._focused && this.mode === "setup" && this.setupFocus === 1;
    this.editor.focused = this._focused && this.mode === "main" && this.composeState !== null;
  }

  private refresh(): void {
    this.invalidate();
    this.updateFocusTargets();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  private maxHeight(): number {
    const rows = process.stdout.rows ?? 40;
    return Math.max(16, Math.min(28, rows - 6));
  }

  private pad(line: string, width: number): string {
    const truncated = truncateToWidth(line, width);
    const padding = Math.max(0, width - visibleWidth(truncated));
    return truncated + " ".repeat(padding);
  }

  private hr(width: number): string {
    return this.theme.fg("accent", "─".repeat(Math.max(1, width)));
  }

  private sectionTitle(text: string, width: number): string {
    const raw = ` ${text} `;
    const line = raw + "─".repeat(Math.max(0, width - visibleWidth(raw)));
    return truncateToWidth(this.theme.fg("accent", line), width);
  }

  private renderTabs(width: number): string {
    const tabs: Array<{ key: Tab; label: string }> = [
      { key: "agents", label: "Agents" },
      { key: "chats", label: "Chats" },
    ];

    return truncateToWidth(
      tabs
        .map((tab) => tab.key === this.tab
          ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${tab.label} `))
          : this.theme.fg("muted", ` ${tab.label} `))
        .join(" "),
      width,
    );
  }

  private getSetupName(): string {
    return this.nameInput.getValue().trim();
  }

  private getSetupRole(): string {
    return this.roleInput.getValue().trim();
  }

  private validateSetup(): string | null {
    if (!this.getSetupName()) return "Name must not be blank.";
    if (!this.getSetupRole()) return "Role must not be blank.";
    return null;
  }

  private tryJoin(): void {
    const validation = this.validateSetup();
    if (validation) {
      this.footerNote = this.theme.fg("warning", validation);
      this.refresh();
      return;
    }

    const result = this.options.join(this.getSetupName(), this.getSetupRole());
    this.footerNote = result.ok
      ? this.theme.fg("success", result.message)
      : this.theme.fg("error", result.message);

    if (result.ok) {
      this.mode = "main";
      this.composeState = null;
      this.tab = "agents";
    }
    this.refresh();
  }

  private renderSetup(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Messenger setup")), width));
    lines.push(truncateToWidth(this.theme.fg("dim", `Project: ${this.options.projectLabel}`), width));
    lines.push(this.hr(width));
    lines.push(truncateToWidth(this.theme.fg("muted", "Choose your messenger name and role before joining."), width));
    lines.push("");

    const fieldLabel = (label: string, selected: boolean) => selected
      ? this.theme.fg("accent", `> ${label}`)
      : this.theme.fg("muted", `  ${label}`);

    lines.push(truncateToWidth(fieldLabel("Agent name", this.setupFocus === 0), width));
    for (const line of this.nameInput.render(width)) lines.push(truncateToWidth(line, width));
    lines.push("");
    lines.push(truncateToWidth(fieldLabel("Role", this.setupFocus === 1), width));
    for (const line of this.roleInput.render(width)) lines.push(truncateToWidth(line, width));
    lines.push("");

    const joinLabel = this.setupFocus === 2
      ? this.theme.bg("selectedBg", this.theme.fg("accent", " Join "))
      : this.theme.fg("accent", "[ Join ]");
    const cancelLabel = this.setupFocus === 3
      ? this.theme.bg("selectedBg", this.theme.fg("warning", " Cancel "))
      : this.theme.fg("warning", "[ Cancel ]");
    lines.push(truncateToWidth(`${joinLabel}  ${cancelLabel}`, width));
    lines.push("");

    const validation = this.validateSetup();
    if (validation) {
      lines.push(truncateToWidth(this.theme.fg("warning", validation), width));
    } else {
      lines.push(truncateToWidth(this.theme.fg("success", "Ready to join."), width));
    }

    lines.push(this.hr(width));
    lines.push(truncateToWidth(this.footerNote || this.theme.fg("dim", "Tab switch field • Enter join • Esc cancel"), width));
    return lines.slice(0, this.maxHeight());
  }

  private otherAgents(): AgentRegistration[] {
    return this.options.getAgents().filter((agent) => agent.name !== this.options.selfName());
  }

  private selectedAgent(): AgentRegistration | undefined {
    const agents = this.otherAgents();
    if (agents.length === 0) return undefined;
    this.selectedAgentIndex = Math.max(0, Math.min(this.selectedAgentIndex, agents.length - 1));
    return agents[this.selectedAgentIndex];
  }

  private selectedThread(): ThreadSummary | undefined {
    const threads = this.options.getThreads();
    if (threads.length === 0) return undefined;
    this.selectedThreadIndex = Math.max(0, Math.min(this.selectedThreadIndex, threads.length - 1));
    return threads[this.selectedThreadIndex];
  }

  private markCurrentThreadRead(): void {
    // No-op: messenger does not track read state.
  }

  private renderMainHeader(width: number): string[] {
    const self = `${this.options.selfName()} (${this.options.selfRole()}) @ ${this.options.projectLabel}`;
    return [
      this.renderTabs(width),
      truncateToWidth(this.theme.fg("dim", self), width),
      this.hr(width),
    ];
  }

  private renderAgentsTab(width: number, height: number): string[] {
    const agents = this.otherAgents();
    const lines: string[] = [this.sectionTitle(`Agents (${agents.length})`, width)];

    if (agents.length === 0) {
      lines.push(this.theme.fg("muted", "No other agents online in this project."));
      lines.push("");
      lines.push(this.theme.fg("dim", "Use messenger in another session to join."));
      return lines.slice(0, height);
    }

    const selected = this.selectedAgent();
    const listHeight = Math.max(4, height - 9);
    const start = Math.max(0, Math.min(this.selectedAgentIndex - Math.floor(listHeight / 2), Math.max(0, agents.length - listHeight)));
    const visible = agents.slice(start, start + listHeight);

    for (let i = 0; i < visible.length; i++) {
      const agent = visible[i]!;
      const index = start + i;
      const prefix = index === this.selectedAgentIndex ? this.theme.fg("accent", "> ") : "  ";
      const label = `${agent.name} (${agent.role})`;
      const body = index === this.selectedAgentIndex
        ? this.theme.fg("accent", label)
        : label;
      lines.push(truncateToWidth(prefix + body, width));
    }

    if (selected) {
      lines.push("");
      lines.push(this.sectionTitle(`Selected: ${selected.name}`, width));
      lines.push(truncateToWidth(`role: ${selected.role}`, width));
      lines.push(truncateToWidth(`branch: ${selected.branch ?? "unknown"}`, width));
      lines.push(truncateToWidth(`model: ${selected.model ?? "unknown"}`, width));
      lines.push(truncateToWidth(`idle: ${formatRelativeTime(selected.lastActivityAt)}`, width));
    }

    return lines.slice(0, height);
  }

  private wrapMessage(text: string, width: number): string[] {
    const words = text.replace(/\r/g, "").split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (visibleWidth(candidate) <= width) current = candidate;
      else {
        if (current) lines.push(truncateToWidth(current, width));
        current = word;
      }
    }
    if (current) lines.push(truncateToWidth(current, width));
    return lines;
  }

  private renderChatsTab(width: number, height: number): string[] {
    const threads = this.options.getThreads();
    const thread = this.selectedThread();
    const leftWidth = Math.max(18, Math.min(30, Math.floor(width * 0.34)));
    const rightWidth = Math.max(24, width - leftWidth - 3);
    const leftLines: string[] = [this.sectionTitle(`Chats (${threads.length})`, leftWidth)];
    const rightLines: string[] = [this.sectionTitle(thread ? `Conversation: ${thread.peerName} (${thread.peerRole})` : "Conversation", rightWidth)];

    if (threads.length === 0) {
      rightLines.push(this.theme.fg("muted", "No direct messages yet."));
      rightLines.push("");
      rightLines.push(this.theme.fg("dim", "Pick an agent and press Enter to start a direct message."));
    }

    const listHeight = Math.max(4, height - 2);
    const start = Math.max(0, Math.min(this.selectedThreadIndex - Math.floor((listHeight - 1) / 2), Math.max(0, threads.length - (listHeight - 1))));
    for (let i = 0; i < Math.min(listHeight - 1, Math.max(0, threads.length - start)); i++) {
      const item = threads[start + i]!;
      const index = start + i;
      const prefix = index === this.selectedThreadIndex ? this.theme.fg("accent", "> ") : "  ";
      leftLines.push(truncateToWidth(`${prefix}${item.peerName} (${item.peerRole})`, leftWidth));
      leftLines.push(truncateToWidth(`   ${this.theme.fg("dim", item.preview)}`, leftWidth));
    }

    if (thread) {
      const recent = thread.messages.slice(-Math.max(3, height - 4));
      for (const message of recent) {
        const mine = message.fromSessionId !== thread.peerSessionId;
        const who = mine
          ? this.theme.fg("accent", `You (${this.options.selfRole()})`)
          : this.theme.fg("text", `${thread.peerName} (${thread.peerRole})`);
        const meta = this.theme.fg("dim", ` ${formatRelativeTime(message.createdAt)}`);
        rightLines.push(truncateToWidth(`${who}${meta}`, rightWidth));
        rightLines.push(...this.wrapMessage(message.text, rightWidth).map((line) => mine ? this.theme.fg("accent", line) : line));
        if (message.replyTo) {
          rightLines.push(truncateToWidth(this.theme.fg("dim", `↳ reply to ${message.replyTo.slice(0, 8)}`), rightWidth));
        }
        rightLines.push("");
      }
    }

    const merged: string[] = [];
    const lineCount = Math.max(leftLines.length, rightLines.length, height);
    for (let i = 0; i < lineCount; i++) {
      const left = this.pad(leftLines[i] ?? "", leftWidth);
      const right = this.pad(rightLines[i] ?? "", rightWidth);
      merged.push(truncateToWidth(`${left} ${this.theme.fg("dim", "│")} ${right}`, width));
    }

    return merged.slice(0, height);
  }

  private renderComposer(width: number): string[] {
    if (!this.composeState) return [];
    const heading = this.composeState.kind === "direct"
      ? `Direct message → ${this.composeState.targetName}`
      : "Broadcast";
    const lines = [this.hr(width), truncateToWidth(this.theme.fg("accent", heading), width)];
    for (const line of this.editor.render(width)) lines.push(truncateToWidth(line, width));
    lines.push(truncateToWidth(this.theme.fg("dim", "Enter send • Esc cancel"), width));
    return lines;
  }

  private renderFooter(width: number): string[] {
    const hints = this.composeState
      ? []
      : [this.theme.fg("dim", "Tab switch • Enter message • B broadcast • Esc close")];
    if (this.tab === "agents" && !this.composeState) hints.unshift(this.theme.fg("dim", "↑↓ pick agent"));
    if (this.tab === "chats" && !this.composeState) hints.unshift(this.theme.fg("dim", "↑↓ pick thread • R reply"));
    return [
      this.hr(width),
      truncateToWidth(this.footerNote || hints.join("  "), width),
    ];
  }

  private renderMain(width: number): string[] {
    const maxHeight = this.maxHeight();
    const bodyHeight = Math.max(8, maxHeight - 6 - (this.composeState ? 6 : 0));
    const lines: string[] = [];
    lines.push(...this.renderMainHeader(width));
    if (this.tab === "agents") lines.push(...this.renderAgentsTab(width, bodyHeight));
    else lines.push(...this.renderChatsTab(width, bodyHeight));
    lines.push(...this.renderComposer(width));
    lines.push(...this.renderFooter(width));
    return lines.slice(0, maxHeight);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.mode === "setup" ? this.renderSetup(width) : this.renderMain(width);
    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    return this.cachedLines;
  }

  private beginDirectMessage(targetSessionId: string, targetName: string, replyTo?: string): void {
    this.composeState = { kind: "direct", targetSessionId, targetName, replyTo };
    this.footerNote = "";
    this.editor.setText("");
    this.refresh();
  }

  private beginBroadcast(replyTo?: string): void {
    this.composeState = { kind: "broadcast", replyTo };
    this.footerNote = "";
    this.editor.setText("");
    this.refresh();
  }

  private moveSetupFocus(delta: -1 | 1): void {
    this.setupFocus = (((this.setupFocus + delta) % 4) + 4) % 4 as SetupFocus;
    this.refresh();
  }

  private handleSetupInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.options.done();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      this.moveSetupFocus(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
      this.moveSetupFocus(-1);
      return;
    }

    if (this.setupFocus === 0) {
      this.nameInput.handleInput(data);
      this.refresh();
      return;
    }
    if (this.setupFocus === 1) {
      this.roleInput.handleInput(data);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter) || data === " ") {
      if (this.setupFocus === 2) this.tryJoin();
      else this.options.done();
    }
  }

  private handleMainInput(data: string): void {
    if (this.composeState) {
      if (matchesKey(data, Key.escape)) {
        this.composeState = null;
        this.footerNote = this.theme.fg("dim", "Compose cancelled.");
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.options.done();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.tab = this.tab === "agents" ? "chats" : "agents";
      this.markCurrentThreadRead();
      this.refresh();
      return;
    }
    if (data === "b" || data === "B") {
      this.beginBroadcast();
      return;
    }

    if (this.tab === "agents") {
      const agents = this.otherAgents();
      if (matchesKey(data, Key.up)) {
        this.selectedAgentIndex = Math.max(0, this.selectedAgentIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectedAgentIndex = Math.min(Math.max(0, agents.length - 1), this.selectedAgentIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const agent = this.selectedAgent();
        if (agent) this.beginDirectMessage(agent.sessionId, agent.name);
      }
      return;
    }

    if (this.tab === "chats") {
      const threads = this.options.getThreads();
      if (matchesKey(data, Key.up)) {
        this.selectedThreadIndex = Math.max(0, this.selectedThreadIndex - 1);
        this.markCurrentThreadRead();
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectedThreadIndex = Math.min(Math.max(0, threads.length - 1), this.selectedThreadIndex + 1);
        this.markCurrentThreadRead();
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter) || data === "r" || data === "R") {
        const thread = this.selectedThread();
        if (thread) {
          const last = thread.messages[thread.messages.length - 1];
          this.beginDirectMessage(thread.peerSessionId, thread.peerName, last?.id);
        }
      }
      return;
    }

  }

  handleInput(data: string): void {
    if (this.mode === "setup") this.handleSetupInput(data);
    else this.handleMainInput(data);
  }
}
