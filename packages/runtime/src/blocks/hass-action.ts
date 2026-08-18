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
  // Deliberately only the default target, not the domain/service: those
  // arrive per-message on the `call` wire (see process() above), so there is
  // no per-node value for them to summarize — printing anything about them
  // here would be a guess. `target` is optional, and most nodes leave it to
  // the incoming call, so this line blanks itself far more often than the
  // other built-ins' do; that's the intended outcome, since a node with no
  // default target genuinely has nothing node-specific to say.
  summary: { icon: "⚡", lines: { "*": "{target.entity_id:truncate}" } },
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
