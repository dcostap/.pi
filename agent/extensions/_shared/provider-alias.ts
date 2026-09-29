import type { AnyModel, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";

/** Keep model IDs and catalog entries under the alias provider. */
export function providerAlias(primary: Provider, id: string, name: string): Provider {
  const remapModels = <T extends AnyModel>(models: readonly T[], provider: string): T[] =>
    models.map((model) => ({ ...model, provider }));
  const remapEntry = (entry: ModelsStoreEntry | undefined, provider: string): ModelsStoreEntry | undefined =>
    entry && { ...entry, models: remapModels(entry.models, provider) };

  return {
    ...primary,
    id,
    name,
    getModels: () => remapModels(primary.getModels(), id),
    // Pi uses this getter for chat models too. Do not leak primary IDs.
    getAllModels: () => remapModels(primary.getAllModels?.() ?? primary.getModels(), id),
    // The source catalog reads primary IDs. The alias stores secondary IDs.
    refreshModels: primary.refreshModels && (async (context) => {
      await primary.refreshModels!({
        ...context,
        stored: remapEntry(context.stored, primary.id),
        publish: (publication) => context.publish({
          ...publication,
          ...(publication.persist && {
            persist: remapEntry(publication.persist, id),
          }),
        }),
      });
    }),
  };
}
