import { defineBlock } from "../block";
import type { TriggerConfig, TriggerOutputs } from "../hass/trigger";
import { registerHassTrigger } from "../hass/trigger";

/**
 * The block definition itself — a real file in this stdlib folder, scanned
 * and registered by discovery/block-loader.ts exactly like a `data/blocks`
 * user block, not a hardcoded registration. The capability this block needs
 * (registerHassTrigger, the flow's one real Home Assistant connection) lives
 * in ../hass/trigger.ts, imported here like any other helper a block author
 * might reach for.
 */
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
