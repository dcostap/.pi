import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";

const PRIMARY_PROVIDER_ID = "openai-codex";
const SECONDARY_PROVIDER_ID = "openai-codex-secondary";
const SECONDARY_PROVIDER_NAME = "OpenAI Codex (Secondary)";

/**
 * Add a second, independently authenticated OpenAI Codex provider.
 *
 * The alias reuses Pi's built-in Codex OAuth and streaming implementations,
 * but every model is remapped to a distinct provider ID. Pi keys auth.json
 * credentials by provider ID, so logging into this alias cannot overwrite the
 * credential stored for the built-in `openai-codex` provider.
 */
export default function openaiCodexSecondary(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const primary = ctx.modelRegistry.getProvider(PRIMARY_PROVIDER_ID);
    if (!primary) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${SECONDARY_PROVIDER_NAME} was not registered because ${PRIMARY_PROVIDER_ID} is unavailable.`,
          "error",
        );
      }
      return;
    }

    const secondary: Provider = {
      ...primary,
      id: SECONDARY_PROVIDER_ID,
      name: SECONDARY_PROVIDER_NAME,
      getModels: () =>
        primary.getModels().map(
          (model): Model<any> => ({
            ...model,
            provider: SECONDARY_PROVIDER_ID,
          }),
        ),
    };

    // Registration after startup is immediate. /login and /model will see the
    // alias for the remainder of this session without modifying the primary.
    pi.registerProvider(secondary);
  });
}
