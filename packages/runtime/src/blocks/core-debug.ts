import { defineBlock } from "../block";
import { serializeForDebug } from "../core/debug";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../core/debug.ts's own serializeForDebug export. */
export default defineBlock<
  Record<string, never>,
  { msg: unknown },
  Record<string, never>
>({
  name: "@core/debug",
  config: {},
  // `unknown`, not a concrete shape — a debug node accepts a wire from any
  // other block's output port (AssertAssignable<unknown, Src> is trivially
  // true for every Src in the generated wire-typecheck), same as Node-RED's
  // debug node taking any msg.
  inputs: { msg: {} as unknown },
  outputs: {},
  async process({ msg }, ctx) {
    // Logged at "debug" level and under this node's own id (attached
    // automatically by worker-manager.ts's log relay — see its own comment)
    // so the editor's Logs panel can filter straight down to just this
    // node's traffic via the node/level filters.
    ctx.log.debug(serializeForDebug(msg));
  },
});
