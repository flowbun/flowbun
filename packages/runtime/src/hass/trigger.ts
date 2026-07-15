import { defineBlock } from "../block";
import { getHass } from "./client";

export interface TriggerConfig {
  entity: string;
}

export interface TriggerOutputs {
  changed: {
    entity: string;
    state: string;
    previous: string | null;
    at: number;
  };
}

export default defineBlock<
  TriggerConfig,
  Record<string, never>,
  TriggerOutputs
>({
  name: "@hass/trigger",
  config: { entity: "" },
  inputs: {},
  outputs: { changed: {} as TriggerOutputs["changed"] },
  async process() {
    // Trigger nodes are never invoked through normal mailbox delivery — the
    // flow-host calls router.emitFromSource() directly instead (see its own
    // doc comment in router.ts for why not ingress()). This exists only so
    // the type machinery (InputsOf/OutputsOf, the typecheck generator)
    // treats @hass/trigger uniformly with other blocks.
    return undefined;
  },
  async subscribe(ctx, emit) {
    return registerHassTrigger(ctx.config, (payload) =>
      emit("changed", payload),
    );
  },
});

/**
 * Called once per node, from that node's own Worker at init (see the
 * block's own `subscribe` above and flow-host/src/worker-entry.ts) — each
 * @hass/trigger node's Worker opens its own independent DA connection via
 * getHass(), not a connection shared across nodes/flows. Wires a live,
 * read-only DA subscription that calls `onChange` whenever the entity's
 * state changes.
 */
export async function registerHassTrigger(
  config: TriggerConfig,
  onChange: (payload: TriggerOutputs["changed"]) => void,
): Promise<() => void> {
  const hass = await getHass();
  const ref = hass.refBy.id(config.entity);

  // Emits whatever HA already knows about this entity right now. Without
  // this, a consumer that only ever sees `onChange` (e.g. state_cache) stays
  // at its default value until the entity happens to change again -- which
  // for a switch that's simply been left in one state can be indefinitely,
  // surviving right across a restart (see battery_controller's per-battery
  // charge/discharge caches, which hit exactly this).
  const emitCurrent = (previous: string | null) => {
    const current = hass.entity.getCurrentState(config.entity);
    if (!current) return;
    onChange({
      entity: config.entity,
      state: current.state,
      previous,
      at: Date.now(),
    });
  };
  emitCurrent(null);

  return ref.onUpdate((newState, oldState) => {
    // DA replays this listener on socket reconnect with no state objects at
    // all (see reference.service.mts's SOCKET_CONNECTED handling) -- fall
    // back to a fresh read instead of crashing on `newState.state`, so a
    // reconnect re-syncs rather than silently dropping the event.
    if (!newState) {
      emitCurrent(oldState?.state ?? null);
      return;
    }
    onChange({
      entity: config.entity,
      state: newState.state,
      previous: oldState?.state ?? null,
      at: Date.now(),
    });
  });
}
