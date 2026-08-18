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
  // The block this exists for: "@core/scheduler" on the canvas says nothing
  // about *when*, which is the only thing anyone opens a scheduler node to
  // check. One line per mode, since a scheduler's config keys are entirely
  // mode-dependent (see SchedulerConfig — `time`/`weekdays` are meaningless
  // in interval mode and vice versa), and a single generic line would have
  // to blank itself for two modes out of three. No "*": an unknown mode is
  // a config error nextFireTime() already throws on, so there's nothing
  // truthful to say about it here.
  summary: {
    icon: "🗓",
    switchOn: "mode",
    lines: {
      interval: "every {intervalMs:duration}",
      // `{time:time}`, not a bare `{time}`: nextDailyTime accepts a
      // single-digit hour ("9:05"), so the raw value renders ragged against
      // every zero-padded sibling on the canvas. The formatter pads it.
      dailyTime: "{weekdays:weekdays} · {time:time}",
      sunRelative: "{event} {offsetMinutes:signedMinutes}",
    },
  },
  // No `hosted: "flow-host"` override — a timer isn't a shared external
  // resource the way an HA connection is, so this runs in an ordinary
  // per-node Worker like any other source with a subscribe, via
  // registerScheduler below.
  async subscribe(ctx, emit) {
    return registerScheduler(ctx.config, (payload) => emit("fired", payload));
  },
});
