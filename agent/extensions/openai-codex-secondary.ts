import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

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
  // Seed the alias during extension initialization, before Pi resolves
  // persisted enabledModels/scoped-models patterns. The placeholder is
  // replaced with the real OAuth-backed provider in session_start below.
  // Without this early catalog, persisted alias patterns are validated before
  // the session_start handler has a chance to register the provider.
  const seededModels = (getModels(PRIMARY_PROVIDER_ID) as Model<any>[]).map(({ provider: _provider, ...model }) => ({
    ...model,
    api: "openai-codex-responses",
  }));

  pi.registerProvider(SECONDARY_PROVIDER_ID, {
    name: SECONDARY_PROVIDER_NAME,
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    // The real OAuth provider replaces this seed in session_start. This
    // placeholder auth is only needed so Pi accepts an already-stored OAuth
    // credential while resolving persisted scoped-model patterns at startup.
    oauth: {
      name: SECONDARY_PROVIDER_NAME,
      async login() {
        throw new Error("OpenAI Codex (Secondary) is initializing; retry login after startup");
      },
      async refreshToken(credentials: any) {
        return credentials;
      },
      getApiKey(credentials: any) {
        return credentials.access;
      },
    },
    models: seededModels as any,
  });

  pi.on("session_start", async (_event, ctx) => {
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

    // Replace only the seed provider. Its placeholder key is never used for
    // requests after startup; the real provider has the built-in Codex OAuth
    // implementation and Pi resolves credentials under the secondary ID.
    pi.registerProvider(secondary);

    // Model selection happens before session_start. Rebind an already-selected
    // secondary model so a resumed/default session cannot retain stale model
    // metadata from the early models.json bootstrap catalog.
    if (ctx.model?.provider === SECONDARY_PROVIDER_ID) {
      const activeModel = secondary.getModels().find((model) => model.id === ctx.model?.id);
      if (activeModel) {
        await pi.setModel(activeModel);
      }
    }
  });
}
