import type { EntityStateReading } from "./client";
import { readEntityState } from "./client";

export interface ReadConfig {
  entity: string;
}

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
