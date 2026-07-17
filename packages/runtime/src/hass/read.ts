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
  async process(_inputs, ctx) {
    const result = await performHassRead(ctx.config.entity);
    return { result };
  },
});

/**
 * The actual effect: read one entity's current state+attributes from HA, via
 * whichever connection readEntityState() resolves to for this thread — the
 * flow's single real connection if called directly, or a relay to it if
 * called from a node's Worker (see hass/client.ts's setHassReadTransport).
 * Always runs for real regardless of isDryRun() — a read never touches real
 * devices, so there's nothing to gate.
 */
export async function performHassRead(
  entity: string,
): Promise<EntityStateReading> {
  const reading = await readEntityState(entity);
  if (!reading) throw new Error(`entity "${entity}" not found`);
  return reading;
}
