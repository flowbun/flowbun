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
});

/**
 * Called once per loaded flow at boot for each @hass/trigger node, NOT per
 * message. Wires a live, read-only DA subscription that calls `onChange`
 * whenever the entity's state changes.
 */
export async function registerHassTrigger(
  config: TriggerConfig,
  onChange: (payload: TriggerOutputs["changed"]) => void,
): Promise<() => void> {
  const hass = await getHass();
  const ref = hass.refBy.id(config.entity);
  return ref.onUpdate((newState, oldState) => {
    onChange({
      entity: config.entity,
      state: newState.state,
      previous: oldState?.state ?? null,
      at: Date.now(),
    });
  });
}
