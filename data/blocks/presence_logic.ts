import { defineBlock } from "flowbun";

export default defineBlock({
  name: "presence_logic",
  config: { entity: "" },
  inputs: { presence: {} as { state: string } },
  outputs: {
    command: {} as {
      domain: string;
      service: string;
      target: { entity_id: string };
      data?: Record<string, unknown>;
    },
  },
  async process({ presence }, ctx) {
    return {
      command: {
        domain: "light",
        service: presence.state === "on" ? "turn_on" : "turn_off",
        target: { entity_id: ctx.config.entity },
      },
    };
  },
});
