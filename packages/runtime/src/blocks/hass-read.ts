import { defineBlock } from "../block";
import type { EntityStateReading } from "../hass/client";
import type { ReadConfig } from "../hass/read";
import { performHassRead } from "../hass/read";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../hass/read.ts's real logic. */
export default defineBlock<
  ReadConfig,
  { request: { at: number } },
  { result: EntityStateReading }
>({
  name: "@hass/read",
  config: { entity: "" },
  // The "request" pulse's own payload is ignored — any input triggers a
  // fresh read of `config.entity`, mirroring @hass/trigger's config-holds-
  // the-entity shape rather than @hass/action's payload-carries-the-target
  // shape (there's no per-call "which entity" decision to make here, unlike
  // an action's target, so it belongs in config, not on the wire).
  inputs: { request: {} as { at: number } },
  outputs: { result: {} as EntityStateReading },
  async process(_inputs, ctx) {
    const result = await performHassRead(ctx.config.entity);
    return { result };
  },
});
