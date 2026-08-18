/**
 * The ordered set of config keys the node config form should render.
 *
 * This used to be "the default config's keys, or the node's own keys if the
 * default is empty", which quietly hid every key a block's default config
 * doesn't happen to mention. `@core/scheduler` is the clearest casualty: its
 * config is a discriminated union over `mode`, and its default is only the
 * `{ mode: "interval", intervalMs }` arm — so a node actually configured as
 * `{ mode: "dailyTime", time, weekdays }` rendered `mode` and `intervalMs`
 * and offered no way at all to see or edit `time`/`weekdays`, the only two
 * fields that meant anything for that node. (The values themselves survived
 * a save, since the form seeds from the node's own config; they were just
 * invisible.) Any block whose config is a union or has optional keys hits
 * this, not just the scheduler.
 *
 * Defaults come first, in declaration order, because that order is the block
 * author's intended field order and is stable across nodes of the same block;
 * keys only the node carries are appended in their own order rather than
 * interleaved, so the familiar shape of a block's form doesn't shuffle around
 * per-node. Keys present in *neither* source (the other union arms' fields)
 * are unreachable here by construction — that is what the raw-JSON escape
 * hatch in ConfigEditor exists for.
 */
export function configFieldKeys(
  defaultConfig: Record<string, unknown>,
  config: Record<string, unknown>,
): string[] {
  const keys = Object.keys(defaultConfig);
  const seen = new Set(keys);
  for (const key of Object.keys(config)) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
