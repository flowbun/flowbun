// S3 spike: read-only entity discovery.
// Uses DA's own `QuickBoot` helper (shipped in @digital-alchemy/hass, intended
// for exactly this "probe the API from a plain script" use case) to bootstrap
// just enough of the DI graph to read `hass.entity`.
//
// READ-ONLY: this script only lists entities and prints states. It never
// calls hass.call.* / any service, and never prints Bun.env.HASS_TOKEN.
import { QuickBoot } from "@digital-alchemy/hass";

console.log("[discover] HASS_BASE_URL =", Bun.env.HASS_BASE_URL);

const { hass, lifecycle } = await QuickBoot("s3_discover");

lifecycle.onReady(() => {
  const sensors = hass.entity.listEntities("sensor");
  console.log(`[discover] total sensor.* entities: ${sensors.length}`);

  // Print a sample of low-sensitivity-looking candidates: anything with
  // "uptime", "date", "time", "processor", "memory", "version", "sun" etc in
  // the id tends to be a safe, non-personal read target.
  const safeish = sensors.filter(id =>
    /uptime|date|time|processor|memory|version|sun_next|disk|cpu|load|update/i.test(id),
  );
  console.log("[discover] candidate low-sensitivity sensors:");
  for (const id of safeish.slice(0, 25)) {
    const state = hass.entity.getCurrentState(id);
    console.log(` - ${id} = ${JSON.stringify(state?.state)}`);
  }

  console.log("[discover] first 15 sensor.* ids (unfiltered, for reference):");
  for (const id of sensors.slice(0, 15)) {
    console.log(` - ${id}`);
  }

  setTimeout(() => process.exit(0), 500);
});
