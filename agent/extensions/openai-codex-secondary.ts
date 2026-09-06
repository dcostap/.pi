import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
export default async function openaiCodexSecondary(pi: ExtensionAPI) {
  // Register native auth and catalog refresh before Pi resolves saved models.
  // The compatibility catalog alone does not include newly discovered models.
  // Restore Pi's cached catalog and models.json overrides without a network request.
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const startupProvider = runtime.getProvider(PRIMARY_PROVIDER_ID);
  if (!startupProvider) throw new Error(`${PRIMARY_PROVIDER_ID} is unavailable`);
  pi.registerProvider({
    ...startupProvider,
    id: SECONDARY_PROVIDER_ID,
    name: SECONDARY_PROVIDER_NAME,
    getModels: () => startupProvider.getModels().map((model) => ({ ...model, provider: SECONDARY_PROVIDER_ID })),
  });

  pi.on("session_start", async (_event, ctx) => {
    const primary = ctx.modelRegistry.getProvider(PRIMARY_PROVIDER_ID);
    if (!primary) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${SECONDARY_PROVIDER_NAME} could not update because ${PRIMARY_PROVIDER_ID} is unavailable.`,
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

    // Include primary provider overrides after startup. Keep separate credentials.
    pi.registerProvider(secondary);

    // Model selection happens before session_start. Update the selected model
    // with any metadata changes from the main runtime.
    if (ctx.model?.provider === SECONDARY_PROVIDER_ID) {
      const activeModel = secondary.getModels().find((model) => model.id === ctx.model?.id);
      if (activeModel) {
        await pi.setModel(activeModel);
      }
    }
  });
}
