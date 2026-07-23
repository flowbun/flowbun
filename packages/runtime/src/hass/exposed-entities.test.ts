import { afterEach, describe, expect, test } from "bun:test";
import type { SimpleHass } from "./client";
import type {
  EntityRegistryEntry,
  ExposedEntitySummary,
} from "./exposed-entities";
import {
  listExposedEntities,
  setExposedEntitiesTransport,
  summarizeExposedEntities,
} from "./exposed-entities";

function fakeHass(
  states: Record<string, { friendly_name?: string }> = {},
): SimpleHass {
  return {
    call: {},
    refBy: { id: () => ({ onUpdate: () => () => {} }) },
    entity: {
      listEntities: () => Object.keys(states),
      getCurrentState: (entityId) => {
        const attrs = states[entityId];
        if (!attrs) return undefined;
        return {
          state: "on",
          last_updated: "2026-01-01T00:00:00Z",
          attributes: attrs,
        };
      },
    },
    socket: {
      // biome-ignore lint/suspicious/noExplicitAny: test double for a generic method never actually invoked in these tests
      sendMessage: (async () => []) as any,
    },
  };
}

function entry(overrides: Partial<EntityRegistryEntry>): EntityRegistryEntry {
  return {
    entity_id: "light.example",
    disabled_by: null,
    hidden_by: null,
    area_id: null,
    ...overrides,
  };
}

describe("summarizeExposedEntities", () => {
  test("includes only entries exposed to the given assistant", () => {
    const hass = fakeHass();
    const entries = [
      entry({
        entity_id: "light.living_room",
        options: { conversation: { should_expose: true } },
      }),
      entry({
        entity_id: "light.kitchen_counter",
        options: { conversation: { should_expose: false } },
      }),
      entry({ entity_id: "light.no_options" }),
    ];
    const result = summarizeExposedEntities(hass, entries, "conversation");
    expect(result.map((r) => r.entity)).toEqual(["light.living_room"]);
  });

  test("excludes disabled or hidden entities even if marked exposed", () => {
    const hass = fakeHass();
    const entries = [
      entry({
        entity_id: "light.disabled",
        disabled_by: "user",
        options: { conversation: { should_expose: true } },
      }),
      entry({
        entity_id: "light.hidden",
        hidden_by: "user",
        options: { conversation: { should_expose: true } },
      }),
    ];
    expect(summarizeExposedEntities(hass, entries, "conversation")).toEqual([]);
  });

  test("checks exposure under the requested assistant key, not any assistant", () => {
    const hass = fakeHass();
    const entries = [
      entry({
        entity_id: "light.google_only",
        options: { "cloud.google_assistant": { should_expose: true } },
      }),
    ];
    expect(summarizeExposedEntities(hass, entries, "conversation")).toEqual([]);
    expect(
      summarizeExposedEntities(hass, entries, "cloud.google_assistant"),
    ).toHaveLength(1);
  });

  test("pulls friendly name from live state and derives domain from the entity id", () => {
    const hass = fakeHass({
      "cover.living_room_blinds": { friendly_name: "Living room blinds" },
    });
    const entries = [
      entry({
        entity_id: "cover.living_room_blinds",
        options: { conversation: { should_expose: true } },
      }),
    ];
    const [result] = summarizeExposedEntities(hass, entries, "conversation");
    expect(result).toEqual({
      entity: "cover.living_room_blinds",
      domain: "cover",
      friendlyName: "Living room blinds",
      aliases: [],
      areaId: null,
    } satisfies ExposedEntitySummary);
  });

  test("filters non-string/null aliases (HA pads with null placeholders)", () => {
    const hass = fakeHass();
    const entries = [
      entry({
        entity_id: "light.aliased",
        aliases: ["Reading lamp", null, "", 5] as unknown as string[],
        options: { conversation: { should_expose: true } },
      }),
    ];
    const result = summarizeExposedEntities(hass, entries, "conversation");
    expect(result[0]?.aliases).toEqual(["Reading lamp"]);
  });

  test("no exposed entities at all yields an empty array, not undefined", () => {
    expect(summarizeExposedEntities(fakeHass(), [], "conversation")).toEqual(
      [],
    );
  });
});

describe("listExposedEntities via a fake transport", () => {
  afterEach(() => {
    setExposedEntitiesTransport(null);
  });

  test("relays through the transport when one is installed", async () => {
    const calls: string[] = [];
    const fake: ExposedEntitySummary[] = [
      {
        entity: "light.living_room",
        domain: "light",
        friendlyName: "Living Room",
        aliases: [],
        areaId: null,
      },
    ];
    setExposedEntitiesTransport({
      list: async (assistant) => {
        calls.push(assistant);
        return fake;
      },
    });
    const result = await listExposedEntities("conversation");
    expect(calls).toEqual(["conversation"]);
    expect(result).toEqual(fake);
  });

  test('defaults to the "conversation" assistant', async () => {
    const calls: string[] = [];
    setExposedEntitiesTransport({
      list: async (assistant) => {
        calls.push(assistant);
        return [];
      },
    });
    await listExposedEntities();
    expect(calls).toEqual(["conversation"]);
  });
});
