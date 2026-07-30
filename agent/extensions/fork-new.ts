import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-new", {
    description: "Start a fresh session linked to the current session",
    handler: async (_args, ctx) => {
      const parentSession = ctx.sessionManager.getSessionFile();

      const result = await ctx.newSession({
        parentSession,
        withSession: async (newCtx) => {
          newCtx.ui.notify(
            parentSession
              ? "Started a fresh session linked to its parent"
              : "Started a fresh session (the previous session was not persisted)",
            "info",
          );
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
      }
    },
  });
}
