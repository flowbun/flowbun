import { defineBlock } from "flowbun";

/**
 * Home Assistant templates read arbitrary entities' *current* state live,
 * regardless of what triggered the automation — Flowbun has no equivalent
 * (ordinary blocks never get a live HA connection; only @hass/trigger and
 * @hass/action do, see the README's "effects at boundary" decision). This
 * block is the workaround: wire a @hass/trigger for the entity you'd have
 * called `states(...)` on, point it at this block instead of your real
 * logic, and it persists the latest value into flow-scoped state under
 * `config.key` — for another block in the same flow to read back with
 * `ctx.state.flow.get(key)` whenever it actually needs to react to
 * something else. See battery_controller.ts for a real example.
 */
export default defineBlock({
  name: "state_cache",
  config: { key: "", as: "number" as "number" | "boolean" },
  inputs: {
    changed: {} as {
      entity: string;
      state: string;
      previous: string | null;
      at: number;
    },
  },
  outputs: {},
  async process({ changed }, ctx) {
    if (!ctx.config.key) return;
    const value =
      ctx.config.as === "boolean"
        ? changed.state === "on"
        : Number.parseFloat(changed.state) || 0;
    await ctx.state.flow.set(ctx.config.key, value);
  },
});
