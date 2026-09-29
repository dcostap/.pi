import { describe, expect, test } from "bun:test";
import type { AnyModel, Model, Provider } from "@earendil-works/pi-ai";
import { providerAlias } from "./provider-alias.ts";

const PRIMARY = "openai-codex";
const SECONDARY = "openai-codex-secondary";
const model = { id: "chat", provider: PRIMARY, type: "chat" } as Model<any>;

function source(overrides: Partial<Provider> = {}): Provider {
  return {
    id: PRIMARY,
    name: "Primary",
    auth: { oauth: {} },
    getModels: () => [model],
    stream: () => { throw new Error("No network in this test"); },
    streamSimple: () => { throw new Error("No network in this test"); },
    ...overrides,
  } as Provider;
}

describe("provider alias", () => {
  test("remaps both catalog getters without changing source models or auth", () => {
    const classifier = { id: "chat", provider: PRIMARY, type: "classifier" } as AnyModel;
    const primary = source({ getAllModels: () => [model, classifier] });
    const alias = providerAlias(primary, SECONDARY, "Secondary");
    expect(alias.id).toBe(SECONDARY);
    expect(alias.name).toBe("Secondary");
    expect(alias.getModels().map(m => m.provider)).toEqual([SECONDARY]);
    expect(alias.getAllModels!().map(m => m.provider)).toEqual([SECONDARY, SECONDARY]);
    expect(alias.getAllModels!().map(m => m.type)).toEqual(["chat", "classifier"]);
    expect(model.provider).toBe(PRIMARY);
    expect(classifier.provider).toBe(PRIMARY);
    expect(alias.auth).toBe(primary.auth);
    expect(alias.stream).toBe(primary.stream);
    expect(alias.streamSimple).toBe(primary.streamSimple);
  });

  test("adds the all-model getter for a chat-only provider", () => {
    const alias = providerAlias(source(), SECONDARY, "Secondary");
    expect(alias.getAllModels!()).toEqual(alias.getModels());
    expect(alias.refreshModels).toBeUndefined();
  });

  test("restores old and new cache IDs, then persists only alias IDs", async () => {
    const signal = new AbortController().signal;
    const stored = {
      models: [model, { ...model, id: "new", provider: SECONDARY }],
      etag: "catalog-version",
      checkedAt: 123,
      lastModified: 100,
    };
    let dynamic: readonly Model<any>[] = [];
    let persisted: any;
    const alias = providerAlias(source({
      getModels: () => dynamic,
      refreshModels: async context => {
        expect(context.signal).toBe(signal);
        expect(context.allowNetwork).toBe(false);
        expect(context.force).toBe(true);
        expect(context.stored?.models.map(m => m.provider)).toEqual([PRIMARY, PRIMARY]);
        expect(context.stored?.etag).toBe(stored.etag);
        expect(context.stored?.lastModified).toBe(stored.lastModified);
        await context.publish({
          persist: context.stored,
          update: () => { dynamic = context.stored!.models as Model<any>[]; },
        });
        await context.publish({ update: () => {} });
      },
    }), SECONDARY, "Secondary");
    await alias.refreshModels!({
      stored,
      signal,
      allowNetwork: false,
      force: true,
      publish: async publication => {
        if (publication.persist) persisted = publication.persist;
        publication.update?.();
        return true;
      },
    } as any);
    expect(persisted.models.map((m: AnyModel) => m.provider)).toEqual([SECONDARY, SECONDARY]);
    expect(persisted.etag).toBe(stored.etag);
    expect(alias.getAllModels!().map(m => m.provider)).toEqual([SECONDARY, SECONDARY]);
    expect(stored.models.map(m => m.provider)).toEqual([PRIMARY, SECONDARY]);
  });

  test("honors a rejected publication without changing catalog state", async () => {
    let updated = false;
    const alias = providerAlias(source({
      refreshModels: async context => {
        expect(context.stored).toBeUndefined();
        const accepted = await context.publish({ update: () => { updated = true; } });
        expect(accepted).toBe(false);
      },
    }), SECONDARY, "Secondary");
    await alias.refreshModels!({
      signal: new AbortController().signal,
      allowNetwork: false,
      publish: async () => false,
    } as any);
    expect(updated).toBe(false);
  });
});
