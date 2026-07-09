import { defineBlock } from "../block";

export interface InjectConfig {
  /** Optional custom button label/tooltip shown in the editor; falls back to "Fire" when empty. */
  label: string;
}

export interface InjectOutputs {
  fired: { at: number };
}

export default defineBlock<InjectConfig, Record<string, never>, InjectOutputs>({
  name: "@core/inject",
  config: { label: "" },
  inputs: {},
  outputs: { fired: {} as InjectOutputs["fired"] },
  async process() {
    // Inject nodes are never invoked through normal mailbox delivery — the
    // coordinator relays a browser button click to the owning flow-host
    // over IPC (flow.fireNode), which calls router.emitFromSource()
    // directly instead (see flow-host/src/main.ts). This exists only so the
    // type machinery (InputsOf/OutputsOf, the typecheck generator) treats
    // @core/inject uniformly with other blocks — mirrors @core/scheduler's
    // and @hass/trigger's own no-op process().
    return undefined;
  },
});
