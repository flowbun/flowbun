/**
 * Self-contained wiring-file fixtures for tests that need real, valid
 * wiring JSON text without depending on production's data/wiring/*.json
 * files — those get edited and deleted as the live app evolves (exactly
 * what broke wiring-writer.test.ts: it used to read data/wiring/
 * hallway_lights.json directly, and stayed broken from the moment that flow
 * was deleted in production). Kept as exact byte-for-byte captures rather
 * than freshly authored JSON, since several of wiring-writer.test.ts's
 * assertions depend on the precise original formatting (inline vs
 * multi-line nodes, a single-line wires array, etc.).
 */

/** hallway_lights.json's shape as of its last committed version (before
 * deletion) — a multi-node, multi-wire flow with one node ("settle")
 * deliberately left inline (no position/disabled field yet), which is what
 * lets wiring-writer.test.ts exercise jsonc-parser's inline-to-multiline
 * expansion behavior. */
export const HALLWAY_LIGHTS_WIRING = `{
  "name": "hallway_lights",
  "nodes": {
    "motion": {
      "block": "@hass/trigger",
      "config": { "entity": "binary_sensor.hallway_motion" }
    },
    "settle": { "block": "debounce", "config": { "ms": 30000 } },
    "decide": {
      "block": "presence_logic",
      "config": { "entity": "light.hallway" }
    },
    "lights": { "block": "@hass/action", "config": {} }
  },
  "wires": [
    ["motion.changed", "settle.signal"],
    ["settle.stable", "decide.presence"],
    ["decide.command", "lights.call"]
  ]
}
`;

/** flowbun_test.json's shape — provided ahead of need since this flow is
 * also slated for deletion from production, same as hallway_lights was.
 * Not consumed by any test yet; here so a future test doesn't have to
 * either depend on the real file or reconstruct it from scratch. Notably
 * the one flow in this repo with an explicit `dryRun` override on an
 * @hass/action config (see distributed-executor.ts's own comment
 * referencing this file by name). */
export const FLOWBUN_TEST_WIRING = `{
  "name": "flowbun_test",
  "nodes": {
    "command": {
      "block": "@hass/trigger",
      "config": { "entity": "input_text.flowbun_test" }
    },
    "map": {
      "block": "domain_toggle",
      "config": {
        "domain": "input_boolean",
        "entity": "input_boolean.flowbun_test"
      }
    },
    "apply": { "block": "@hass/action", "config": { "dryRun": false } }
  },
  "wires": [["command.changed", "map.changed"], ["map.command", "apply.call"]]
}
`;
