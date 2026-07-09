import { defineBlock } from "../block";
import type { EntityStateReading } from "./client";
import { readEntityState } from "./client";

export interface ReadConfig {
  entity: string;
}

export default defineBlock<
  ReadConfig,
  { request: { at: number } },
  { result: EntityStateReading }
>({
  name: "@hass/read",
  config: { entity: "" },
  // The "request" pulse's own payload is ignored — any input triggers a
  // fresh read of `config.entity`, mirroring @hass/trigger's config-holds-
  // the-entity shape rather than @hass/action's payload-carries-the-target
  // shape (there's no per-call "which entity" decision to make here, unlike
  // an action's target, so it belongs in config, not on the wire).
  inputs: { request: {} as { at: number } },
  outputs: { result: {} as EntityStateReading },
  async process() {
    // Boundary block — no in-process work, same pattern as @hass/action and
    // @hass/trigger. The real read happens at the coordinator, the only
    // process holding the live HA connection in the distributed topology
    // (see performHassRead below and coordinator/ha-relay.ts).
    return undefined;
  },
});

/**
 * The actual effect: read one entity's current state+attributes from HA.
 * Shared by two callers, mirroring performHassAction's own split (see
 * hass/action.ts): this file's own process() (Phase 1's in-process path,
 * currently unreachable — see below) and the coordinator's ha-relay.ts
 * (Phase 2's distributed path, the only place this runs for real once the
 * flow-host special-cases @hass/read nodes instead of invoking process()).
 * Unlike performHassAction, this always runs for real regardless of
 * isDryRun() — a read never touches real devices, so there's nothing to gate.
 */
export async function performHassRead(
  entity: string,
): Promise<EntityStateReading> {
  const reading = await readEntityState(entity);
  if (!reading) throw new Error(`entity "${entity}" not found`);
  return reading;
}
