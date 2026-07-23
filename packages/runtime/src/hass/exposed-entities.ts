import type { SimpleHass } from "./client";
import { getHass } from "./client";

/**
 * The subset of a `config/entity_registry/list` websocket reply entry this
 * file actually reads. Real entries carry many more fields (device_id,
 * config_entry_id, capabilities, ...) — deliberately untyped/ignored here,
 * same "narrow, explicit boundary cast" reasoning as SimpleHass itself (see
 * client.ts's own module doc comment).
 */
export interface EntityRegistryEntry {
  entity_id: string;
  disabled_by: string | null;
  hidden_by: string | null;
  area_id: string | null;
  aliases?: unknown;
  options?: Record<string, { should_expose?: boolean } | undefined>;
}

export interface ExposedEntitySummary {
  entity: string;
  domain: string;
  friendlyName?: string;
  aliases: string[];
  areaId: string | null;
}

/**
 * A node's Worker has no Home Assistant connection of its own (see
 * client.ts's doc comment on HassReadTransport) — worker-entry.ts installs
 * this to relay through to the flow's one real connection in the flow-host's
 * main thread, exactly like setHassReadTransport/setHassCallTransport.
 */
export interface ExposedEntitiesTransport {
  list(assistant: string): Promise<ExposedEntitySummary[]>;
}

let transport: ExposedEntitiesTransport | null = null;

export function setExposedEntitiesTransport(
  t: ExposedEntitiesTransport | null,
): void {
  transport = t;
}

// DA's socket.sendMessage never rejects on a `success:false` reply — it
// just logs and leaves the promise pending forever (see SimpleHass's own
// doc comment on `socket`). Mirrors action.ts's HASS_CALL_ACK_TIMEOUT_MS
// reasoning: better to answer "nothing this round" than hang the caller (an
// entity_directory block's exec, ultimately WorkerManager's own
// WORKER_EXEC_TIMEOUT_MS) on a lost reply.
const REGISTRY_LIST_TIMEOUT_MS = 8_000;

function timeout<T>(ms: number): Promise<T | undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

function summarize(
  hass: SimpleHass,
  entry: EntityRegistryEntry,
): ExposedEntitySummary {
  const aliases = Array.isArray(entry.aliases)
    ? entry.aliases.filter(
        (a): a is string => typeof a === "string" && a.length > 0,
      )
    : [];
  return {
    entity: entry.entity_id,
    domain: entry.entity_id.split(".")[0] ?? entry.entity_id,
    friendlyName: hass.entity.getCurrentState(entry.entity_id)?.attributes
      .friendly_name as string | undefined,
    aliases,
    areaId: entry.area_id,
  };
}

/**
 * The pure filter+map step, split out from listExposedEntities so it's
 * testable with a fake SimpleHass and a hand-built entry list — no need to
 * fake getHass()'s module-level dynamic import or a real socket round trip
 * (mirrors action.test.ts's own reasoning: the connection-touching branch
 * is exercised for real by the flow-host's worker-manager.ts relay
 * handler, not by a unit test double).
 */
export function summarizeExposedEntities(
  hass: SimpleHass,
  entries: EntityRegistryEntry[],
  assistant: string,
): ExposedEntitySummary[] {
  return entries
    .filter(
      (e) =>
        !e.disabled_by &&
        !e.hidden_by &&
        e.options?.[assistant]?.should_expose === true,
    )
    .map((e) => summarize(hass, e));
}

/**
 * The entities a given voice assistant ("conversation" is HA's own
 * Assist/Assist API assistant id) is actually allowed to see and act on —
 * the per-entity "Voice assistants" exposure toggle in HA's entity
 * settings, NOT "every entity that exists" (@hass/action can target any
 * entity id regardless of exposure; this is purely about what an LLM
 * *should* be told it may offer). Disabled/hidden entities are excluded
 * even if marked exposed — HA's own UI does the same, and an excluded
 * entity id would fail if actually called.
 *
 * Routes through `transport` when one's installed (a node's Worker — see
 * worker-entry.ts); otherwise reads straight off this thread's own
 * getHass() connection, mirroring readEntityState/performHassAction's own
 * dual-path pattern. Never throws: a transport timeout, a socket error, or
 * a stale/never-settling DA promise all degrade to an empty list rather
 * than failing whatever triggered the refresh — a stale or empty
 * directory just means the agent under-reports what it can control this
 * round, not a broken flow.
 */
export async function listExposedEntities(
  assistant = "conversation",
): Promise<ExposedEntitySummary[]> {
  if (transport) return transport.list(assistant);
  const hass = await getHass();
  const entries = await Promise.race([
    hass.socket.sendMessage<EntityRegistryEntry[]>({
      type: "config/entity_registry/list",
    }),
    timeout<EntityRegistryEntry[]>(REGISTRY_LIST_TIMEOUT_MS),
  ]);
  if (!entries) return [];
  return summarizeExposedEntities(hass, entries, assistant);
}
