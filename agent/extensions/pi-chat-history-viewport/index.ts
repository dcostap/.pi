import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

type RenderFn = (width: number) => string[];

interface PatchState {
  tui: any;
  historyContainer: any;
  originalRender: RenderFn;
  removeInputListener: (() => void) | null;
}

function ctorName(value: any): string {
  return value?.constructor?.name ?? typeof value;
}

function safeRenderLines(component: any, width: number): string[] {
  if (typeof component?.render !== "function") return [];
  const lines = component.render(width);
  return Array.isArray(lines) ? lines : [];
}

function isHistoryContainerCandidate(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (!Array.isArray(node.children) || node.children.length === 0) return false;

  let score = 0;
  for (const child of node.children) {
    const name = ctorName(child);
    if (name === "UserMessageComponent") score += 3;
    else if (name === "AssistantMessageComponent") score += 3;
    else if (name === "ToolExecutionComponent") score += 2;
    else if (name === "Spacer") score += 0;
    else if (name === "Text" || name === "ExpandableText") score += 1;
  }

  return score >= 8;
}

function findHistoryContainer(tui: any): any | null {
  const children = Array.isArray(tui?.children) ? tui.children : [];

  let best: { node: any; score: number } | null = null;
  for (const child of children) {
    if (!isHistoryContainerCandidate(child)) continue;

    let score = 0;
    for (const grandchild of child.children) {
      const name = ctorName(grandchild);
      if (name === "UserMessageComponent") score += 3;
      else if (name === "AssistantMessageComponent") score += 3;
      else if (name === "ToolExecutionComponent") score += 2;
      else if (name === "ExpandableText") score += 1;
    }

    if (!best || score > best.score) {
      best = { node: child, score };
    }
  }

  return best?.node ?? null;
}

export default function chatHistoryViewport(pi: ExtensionAPI) {
  let enabled = false;
  let currentCtx: any = null;
  let currentTui: any = null;
  let currentEditorFactory: any = null;
  let installedEditorFactory: any = null;
  let patch: PatchState | null = null;
  let installGeneration = 0;
  let scrollOffset = 0;
  let lastLineCount = 0;
  let renderingPatchedHistory = false;

  function notify(message: string, level: "info" | "warning" = "info"): void {
    currentCtx?.ui?.notify?.(message, level);
  }

  function teardownPatch(): void {
    if (patch) {
      patch.historyContainer.render = patch.originalRender;
      patch.removeInputListener?.();
      patch.removeInputListener = null;
      patch = null;
    }
    scrollOffset = 0;
    lastLineCount = 0;
  }

  function computeReservedRows(tui: any, historyContainer: any, width: number): number {
    const children = Array.isArray(tui?.children) ? tui.children : [];
    let reserved = 0;
    for (const child of children) {
      if (child === historyContainer) continue;
      reserved += safeRenderLines(child, width).length;
    }
    return reserved;
  }

  function clampScroll(lineCount: number, viewportRows: number): void {
    const maxOffset = Math.max(0, lineCount - viewportRows);
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  }

  function installPatch(tui: any): void {
    teardownPatch();

    const historyContainer = findHistoryContainer(tui);
    if (!historyContainer || typeof historyContainer.render !== "function") {
      notify("chat-history-viewport: could not find chat history container", "warning");
      return;
    }

    const originalRender = historyContainer.render.bind(historyContainer);

    historyContainer.render = (width: number): string[] => {
      if (renderingPatchedHistory) {
        return originalRender(width);
      }

      renderingPatchedHistory = true;
      try {
        const fullLines = originalRender(width);
        const lineCount = Array.isArray(fullLines) ? fullLines.length : 0;
        const terminalRows = Math.max(1, tui?.terminal?.rows ?? 24);
        const reservedRows = computeReservedRows(tui, historyContainer, width);
        const viewportRows = Math.max(1, terminalRows - reservedRows);

        if (scrollOffset > 0 && lineCount > lastLineCount) {
          scrollOffset += lineCount - lastLineCount;
        }
        lastLineCount = lineCount;
        clampScroll(lineCount, viewportRows);

        const start = Math.max(0, lineCount - viewportRows - scrollOffset);
        const visible = fullLines.slice(start, start + viewportRows);
        while (visible.length < viewportRows) visible.push("");
        return visible;
      } finally {
        renderingPatchedHistory = false;
      }
    };

    let removeInputListener: (() => void) | null = null;
    if (typeof tui?.addInputListener === "function") {
      removeInputListener = tui.addInputListener((data: string) => {
        if (!enabled || tui?.hasOverlay?.() || isKeyRelease(data)) return undefined;

        const width = Math.max(1, tui?.terminal?.columns ?? 80);
        const lineCount = safeRenderLines({ render: originalRender }, width).length;
        const terminalRows = Math.max(1, tui?.terminal?.rows ?? 24);
        const reservedRows = computeReservedRows(tui, historyContainer, width);
        const viewportRows = Math.max(1, terminalRows - reservedRows);
        const maxOffset = Math.max(0, lineCount - viewportRows);

        const apply = (nextOffset: number) => {
          const clamped = Math.max(0, Math.min(nextOffset, maxOffset));
          if (clamped === scrollOffset) return { consume: true };
          scrollOffset = clamped;
          tui.requestRender?.();
          return { consume: true };
        };

        if (matchesKey(data, "pageUp")) return apply(scrollOffset + 10);
        if (matchesKey(data, "pageDown")) return apply(scrollOffset - 10);
        if (matchesKey(data, "home")) return apply(maxOffset);
        if (matchesKey(data, "end")) return apply(0);
        return undefined;
      });
    }

    patch = { tui, historyContainer, originalRender, removeInputListener };
    currentTui = tui;

    try {
      tui?.terminal?.write?.("\x1b[3J\x1b[2J\x1b[H\x1b[0m");
    } catch {
      // best-effort cleanup of stale pre-TUI terminal content
    }

    tui.requestRender?.(true);
    queueMicrotask(() => tui.requestRender?.(true));
    setTimeout(() => tui.requestRender?.(true), 10);
  }

  function applyEnabledUi(ctx: any): void {
    const currentFactory = ctx.ui.getEditorComponent?.();
    if (currentFactory && currentFactory !== installedEditorFactory) {
      currentEditorFactory = currentFactory;
    }

    const generation = ++installGeneration;
    installedEditorFactory = (tui: any, theme: any, keybindings: any) => {
      const editor = currentEditorFactory
        ? currentEditorFactory(tui, theme, keybindings)
        : undefined;
      queueMicrotask(() => {
        if (!enabled || generation !== installGeneration) return;
        installPatch(tui);
      });
      return editor;
    };

    if (installedEditorFactory) {
      ctx.ui.setEditorComponent(installedEditorFactory);
    }
  }

  function applyDisabledUi(ctx: any): void {
    teardownPatch();
    ctx.ui.setEditorComponent(currentEditorFactory ?? undefined);
    installedEditorFactory = null;
  }

  function syncUi(ctx: any): void {
    if (!ctx.hasUI) return;
    if (enabled) applyEnabledUi(ctx);
    else applyDisabledUi(ctx);
  }

  function setEnabled(next: boolean): void {
    enabled = next;
    if (currentCtx?.hasUI) {
      syncUi(currentCtx);
      notify(
        enabled
          ? "Chat history viewport on — PageUp/PageDown scroll chat, Home jumps top, End jumps bottom"
          : "Chat history viewport off",
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    currentEditorFactory = ctx.ui.getEditorComponent?.() ?? null;
    installedEditorFactory = null;
    syncUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    teardownPatch();
    currentCtx = null;
    currentTui = null;
    installedEditorFactory = null;
  });

  pi.registerCommand("chat-viewport", {
    description: "Toggle independent chat history viewport mode",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const normalized = (args || "toggle").trim().toLowerCase();
      if (normalized === "on") return void setEnabled(true);
      if (normalized === "off") return void setEnabled(false);
      setEnabled(!enabled);
    },
  });

  pi.registerShortcut("ctrl+alt+v", {
    description: "Toggle chat history viewport mode",
    handler: async (ctx) => {
      currentCtx = ctx;
      setEnabled(!enabled);
    },
  });
}
