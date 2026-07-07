import { defineBlock } from "../block";
import { getHass, isDryRun } from "./client";

export interface ActionCall {
  domain: string;
  service: string;
  target?: { entity_id: string };
  data?: Record<string, unknown>;
}

export interface ActionConfig {
  target?: { entity_id: string };
}

/**
 * The actual effect: given a fully-resolved call (target already merged in
 * by the caller — see below) and a dry-run flag, either no-op or really call
 * hass.call[domain][service](...). Deliberately has no logging of its own —
 * callers log, since they're the ones with a Logger/trace context in scope.
 *
 * Shared by two callers so this logic is never duplicated: this file's own
 * process() (Phase 1's in-process path) and the coordinator's ha-relay.ts
 * (Phase 2's distributed path, the only place this runs for real once the
 * flow-host special-cases @hass/action nodes instead of invoking process()).
 */
export async function performHassAction(
  call: ActionCall,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const hass = await getHass();
  // DA's hass.call proxy sends whatever object we pass verbatim as the
  // websocket message's service_data — there's no separate "target" slot at
  // this layer, unlike HA's newer target-based REST API. Confirmed against
  // DA's own call-proxy.spec.mts: entity targeting is done by flattening
  // entity_id directly into the data object (HA's classic convention), not
  // by nesting it under a "target" key — nesting produces a real HA-side
  // "extra keys not allowed @ data['target']" rejection.
  await hass.call[call.domain]?.[call.service]?.({
    ...(call.data ?? {}),
    ...(call.target?.entity_id ? { entity_id: call.target.entity_id } : {}),
  });
}

export default defineBlock<
  ActionConfig,
  { call: ActionCall },
  Record<string, never>
>({
  name: "@hass/action",
  config: {},
  inputs: { call: {} as ActionCall },
  outputs: {},
  async process({ call }, ctx) {
    const resolved: ActionCall = {
      ...call,
      target: call.target ?? ctx.config.target,
    };
    const dryRun = isDryRun();

    await performHassAction(resolved, dryRun);

    ctx.log.info(dryRun ? "hass.dry_run_call" : "hass.call", {
      domain: resolved.domain,
      service: resolved.service,
      target: resolved.target,
      data: resolved.data,
    });
  },
});
