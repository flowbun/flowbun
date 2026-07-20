// The block definition itself lives in blocks/core-debug.ts (see its own
// doc comment) — this file is just the shared serialization helper.
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
