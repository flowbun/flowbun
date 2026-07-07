import { defineBlock } from "../block";
import { getHass, isDryRun } from "./client";

export interface ActionCall {
  domain: string;
  service: string;
  target?: { entity_id: string };
  data?: Record<string, unknown>;
}

export interface ActionConfig {
  target?: { entity_id: string };
}

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
    const target = call.target ?? ctx.config.target;

    if (isDryRun()) {
      ctx.log.info("hass.dry_run_call", {
        domain: call.domain,
        service: call.service,
        target,
        data: call.data,
      });
      return;
    }

    const hass = await getHass();
    await hass.call[call.domain]?.[call.service]?.({
      ...(call.data ?? {}),
      ...(target ? { target } : {}),
    });
    ctx.log.info("hass.call", {
      domain: call.domain,
      service: call.service,
      target,
      data: call.data,
    });
  },
});
