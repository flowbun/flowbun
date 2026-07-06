// S3 spike: the read-only proof point.
//
// Bootstraps @digital-alchemy/hass headlessly via DA's own `QuickBoot` helper
// (see node_modules/@digital-alchemy/hass/src/quickboot.module.mts -- shipped
// by DA itself "to probe apis" from the node command line, exactly this use
// case), reads the current state of one real, low-sensitivity entity, and
// subscribes to its state-change stream for a short window.
//
// Entity chosen: sensor.ebusd_global_uptime -- a monotonic uptime counter
// (seconds) reported by the household boiler control system (ebusd
// integration). It is not personal data, not derived from presence/location,
// and is definitionally read-only (a "sensor.*" entity, HA's read-only
// convention) -- it just counts up.
//
// READ-ONLY: never calls hass.call.* / any service. Never prints Bun.env.HASS_TOKEN.
import { QuickBoot } from "@digital-alchemy/hass";

const TARGET_ENTITY = "sensor.ebusd_global_uptime";
const WATCH_WINDOW_MS = 18_000;

console.log("[subscribe] HASS_BASE_URL =", Bun.env.HASS_BASE_URL);
console.log("[subscribe] target entity =", TARGET_ENTITY);

const { hass, lifecycle } = await QuickBoot("s3_subscribe");

lifecycle.onReady(() => {
  const current = hass.entity.getCurrentState(TARGET_ENTITY);
  console.log("[subscribe] current state:", JSON.stringify(current?.state));
  console.log("[subscribe] last_updated:", current?.last_updated);

  // clean, type-safe reference API from README, read-only usage only
  const ref = hass.refBy.id(TARGET_ENTITY);
  console.log(`[subscribe] watching for up to ${WATCH_WINDOW_MS / 1000}s for a natural state-change event...`);

  let sawEvent = false;
  const remove = ref.onUpdate((new_state, old_state) => {
    sawEvent = true;
    console.log("[subscribe] state-change event observed:");
    console.log("  old:", JSON.stringify(old_state?.state), old_state?.last_updated);
    console.log("  new:", JSON.stringify(new_state?.state), new_state?.last_updated);
  });

  setTimeout(() => {
    remove();
    if (!sawEvent) {
      console.log(`[subscribe] no natural state-change event arrived within ${WATCH_WINDOW_MS / 1000}s window (this is noted as acceptable per spike scope).`);
    }
    console.log("[subscribe] done.");
    process.exit(0);
  }, WATCH_WINDOW_MS);
});
