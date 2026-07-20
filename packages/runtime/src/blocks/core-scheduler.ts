import { defineBlock } from "../block";
import type { SchedulerConfig, SchedulerOutputs } from "../core/scheduler";
import { registerScheduler } from "../core/scheduler";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../core/scheduler.ts's real logic. */
export default defineBlock<
  SchedulerConfig,
  Record<string, never>,
  SchedulerOutputs
>({
  name: "@core/scheduler",
  kind: "source",
  config: { mode: "interval", intervalMs: 60_000 },
  inputs: {},
  outputs: { fired: {} as SchedulerOutputs["fired"] },
  // No `hosted: "flow-host"` override — a timer isn't a shared external
  // resource the way an HA connection is, so this runs in an ordinary
  // per-node Worker like any other source with a subscribe, via
  // registerScheduler below.
  async subscribe(ctx, emit) {
    return registerScheduler(ctx.config, (payload) => emit("fired", payload));
  },
});
