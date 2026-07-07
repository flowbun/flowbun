import { defineBlock } from "flowbun";
import { z } from "zod";

// Demo block proving "flexible, not dogmatic": an arbitrary third-party API
// call with fetch, validated at the boundary with Zod. Open-Meteo is free
// and keyless, so this needs no credentials of its own.
const OpenMeteoResponse = z.object({
  current: z.object({ temperature_2m: z.number(), time: z.string() }),
});

export default defineBlock({
  name: "outdoor_temp",
  config: { latitude: 51.5074, longitude: -0.1278 },
  inputs: { poll: {} as { at: number } },
  outputs: { reading: {} as { celsius: number; observedAt: string } },
  async process(_inputs, ctx) {
    const { latitude, longitude } = ctx.config;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`;
    const res = await fetch(url);
    const parsed = OpenMeteoResponse.parse(await res.json());
    return {
      reading: {
        celsius: parsed.current.temperature_2m,
        observedAt: parsed.current.time,
      },
    };
  },
});
