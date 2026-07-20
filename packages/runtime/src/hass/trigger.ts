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
  kind: "source",
  // The flow's one real Home Assistant connection lives in the flow-host's
  // own main thread, not in a per-node Worker — see WorkerManager's own doc
  // comment. flow-host/src/main.ts calls this block's own `subscribe`
  // directly, in that thread, for every "hosted: flow-host" source.
  hosted: "flow-host",
  config: { entity: "" },
  inputs: {},
  outputs: { changed: {} as TriggerOutputs["changed"] },
  async subscribe(ctx, emit) {
    return registerHassTrigger(ctx.config, (payload) =>
      emit("changed", payload),
    );
  },
});

/**
 * Called once per @hass/trigger node. In the distributed topology this
 * runs directly in the flow-host's main thread (flow-host/src/main.ts),
 * exactly like @core/scheduler's registerScheduler — @hass/trigger nodes
 * don't get their own Worker at all (see WorkerManager's own doc comment),
 * since the flow's one real HA connection (getHass()) lives in that thread,
 * not in a per-node Worker. The `subscribe` hook on the block definition
 * above exists only for Phase 1's in-process demo, which has no
 * Worker/flow-host split to begin with. Wires a live, read-only DA
 * subscription that calls `onChange` whenever the entity's state changes.
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
