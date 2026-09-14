import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  // Use a separate runtime so each provider has independent catalog state.
  // Register before Pi resolves saved model scopes.
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const primary = runtime.getProvider(PRIMARY_PROVIDER_ID);
  if (!primary) throw new Error(`${PRIMARY_PROVIDER_ID} is unavailable`);

  pi.registerProvider({
    ...primary,
    id: SECONDARY_PROVIDER_ID,
    name: SECONDARY_PROVIDER_NAME,
    getModels: () => primary.getModels().map((model) => ({ ...model, provider: SECONDARY_PROVIDER_ID })),
  });
}
