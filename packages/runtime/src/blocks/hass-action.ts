import { defineBlock } from "../block";
import type { ActionCall, ActionConfig } from "../hass/action";
import { performHassAction } from "../hass/action";
import { isDryRun } from "../hass/client";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../hass/action.ts's real logic. */
export default defineBlock<
  ActionConfig,
  { call: ActionCall },
  Record<string, never>
>({
  name: "@hass/action",
  config: {},
  inputs: { call: {} as ActionCall },
  outputs: {},
  async process({ call }, ctx) {
    const resolved: ActionCall = {
      ...call,
      target: call.target ?? ctx.config.target,
    };
    const dryRun = ctx.config.dryRun ?? isDryRun();

    await performHassAction(resolved, dryRun);

    ctx.log.info(dryRun ? "hass.dry_run_call" : "hass.call", {
      domain: resolved.domain,
      service: resolved.service,
      target: resolved.target,
      data: resolved.data,
    });
  },
});
