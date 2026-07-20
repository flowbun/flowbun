import { defineBlock } from "../block";
import type { SimpleHass } from "./client";
import { getHass, isDryRun } from "./client";

export interface ActionCall {
  domain: string;
  service: string;
  target?: { entity_id: string | string[] };
  data?: Record<string, unknown>;
}

export interface ActionConfig {
  target?: { entity_id: string | string[] };
  // Per-node override of the process-wide FLOWBUN_DRY_RUN default (see
  // isDryRun() in ./client) — lets one flow go live for real testing while
  // every other flow on the same coordinator stays safely in dry-run.
  // Typed here (rather than left as an untyped raw wiring-config key) now
  // that the typecheck gate validates node configs against their block's
  // declared Config shape (see typecheck/generate.ts) — an untyped
  // override would be rejected as an excess property.
  dryRun?: boolean;
}

/**
 * A flow owns exactly one real Home Assistant connection, opened once in the
 * flow-host's main thread (see hass/client.ts's doc comment on
 * setHassReadTransport and WorkerManager's own doc comment) — a node's
 * Worker has no connection of its own and relays through `callTransport`
 * instead (installed by worker-entry.ts). Unset (null) wherever a real
 * connection is already directly at hand: the flow-host's own main thread,
 * and Phase 1's single-process in-process demo.
 */
export interface HassCallTransport {
  call(action: ActionCall, dryRun: boolean): Promise<void>;
}

let callTransport: HassCallTransport | null = null;

export function setHassCallTransport(
  transport: HassCallTransport | null,
): void {
  callTransport = transport;
}

/**
 * hass.call is DA's own Proxy over whatever services HA actually reported at
 * boot (see call-proxy.service.mts) — indexing a domain/service that isn't
 * registered genuinely returns undefined, it's not just a type-level
 * possibility. Throwing here (rather than the `?.`-chained silent no-op this
 * replaced) is what makes a typo'd domain/service surface as a real error
 * instead of a "hass.call" success log for an action that never happened —
 * this runtime is currently making real, non-dry-run writes to real hardware.
 */
export function resolveHassService(
  hass: SimpleHass,
  domain: string,
  service: string,
): (args?: Record<string, unknown>) => Promise<unknown> {
  const fn = hass.call[domain]?.[service];
  if (!fn) {
    throw new Error(
      `Home Assistant service "${domain}.${service}" is not available`,
    );
  }
  return fn;
}

/**
 * The actual effect: given a fully-resolved call (target already merged in
 * by the caller — see below) and a dry-run flag, either no-op or really call
 * hass.call[domain][service](...). Routes through `callTransport` when one's
 * installed (a node's Worker); otherwise calls straight out over this
 * thread's own `getHass()` connection. Deliberately has no logging of its
 * own — the caller (this file's own process(), below) logs, since it's the
 * one with a Logger/trace context in scope.
 */
export async function performHassAction(
  call: ActionCall,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  if (callTransport) return callTransport.call(call, dryRun);
  const hass = await getHass();
  const service = resolveHassService(hass, call.domain, call.service);
  // DA's hass.call proxy sends whatever object we pass verbatim as the
  // websocket message's service_data — there's no separate "target" slot at
  // this layer, unlike HA's newer target-based REST API. Confirmed against
  // DA's own call-proxy.spec.mts: entity targeting is done by flattening
  // entity_id directly into the data object (HA's classic convention), not
  // by nesting it under a "target" key — nesting produces a real HA-side
  // "extra keys not allowed @ data['target']" rejection.
  await service({
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
    const dryRun = ctx.config.dryRun ?? isDryRun();

    await performHassAction(resolved, dryRun);

    ctx.log.info(dryRun ? "hass.dry_run_call" : "hass.call", {
      domain: resolved.domain,
      service: resolved.service,
      target: resolved.target,
      data: resolved.data,
    });
  },
});
