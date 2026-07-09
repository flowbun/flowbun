import { defineBlock } from "../block";

/**
 * JSON.stringify(undefined) returns the *value* undefined, not the string
 * "undefined" — and throws on bigint/circular input. A debug node's whole
 * job is showing exactly what's flowing through a wire, including values
 * that don't happen to be JSON-safe, so this never lets a bad payload take
 * the rest of the flow down with it — it surfaces the problem as the logged
 * line instead.
 */
export function serializeForDebug(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch (err) {
    return `<unserializable: ${String(err)}>`;
  }
}

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
