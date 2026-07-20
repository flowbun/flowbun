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
  kind: "source",
  // No `subscribe` — this source never emits on its own. `fireable: true` is
  // what actually makes it work: the coordinator relays a browser button
  // click to the owning flow-host over IPC (flow.fireNode), which checks
  // this flag (rather than a hardcoded block-name check) before calling
  // router.emitFromSource() directly — see flow-host/src/main.ts.
  fireable: true,
  config: { label: "" },
  inputs: {},
  outputs: { fired: {} as InjectOutputs["fired"] },
});
