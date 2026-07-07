import { defineBlock } from "flowbun";

export default defineBlock({
  name: "debounce",
  config: { ms: 30_000 },
  inputs: { signal: {} as { state: string; at: number } },
  outputs: { stable: {} as { state: string } },
  async process({ signal }, ctx) {
    // Leading-edge debounce: forward the first signal in a burst, then
    // suppress repeats until `ms` has elapsed since the last forwarded one.
    // (Phase 1's ctx has no delayed-emission API yet, so a trailing-edge
    // "wait for quiet, then emit" debounce isn't expressible here.)
    const last = await ctx.state.block.get<number>("lastAt");
    if (last !== undefined && signal.at - last < ctx.config.ms) {
      return;
    }
    await ctx.state.block.set("lastAt", signal.at);
    return { stable: { state: signal.state } };
  },
});
