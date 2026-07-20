import { defineBlock } from "../block";
import type { InjectConfig, InjectOutputs } from "../core/inject";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../core/inject.ts's own type exports. */
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
