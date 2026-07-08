import { defineBlock } from "flowbun";

export default defineBlock({
  name: "domain_toggle",
  config: { domain: "input_boolean", entity: "" },
  inputs: {
    changed: {} as {
      entity: string;
      state: string;
      previous: string | null;
      at: number;
    },
  },

  outputs: {
    command: {} as {
      domain: string;
      service: string;
      target: { entity_id: string };
      data?: Record<string, unknown>;
    },
  },

  async process({ changed }, ctx) {
    if (changed.state !== "on" && changed.state !== "off") return; // ignore any other input_text value
    return {
      command: {
        domain: ctx.config.domain,
        service: changed.state === "on" ? "turn_on" : "turn_off",
        target: { entity_id: ctx.config.entity },
      },
    };
  },
});
