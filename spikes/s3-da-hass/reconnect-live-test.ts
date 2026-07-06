// S3 spike: reconnect/backoff behavior probe, take 2.
//
// Take 1 (reconnect-test.ts) showed that a bad BASE_URL *at initial boot*
// causes a hard, fatal bootstrap failure (process.exit) rather than any
// retry -- the REST prefetch of entities during PostConfig is not wrapped
// in the resilient reconnect state machine.
//
// This script instead boots normally against the REAL instance (read-only:
// only auth + state prefetch + subscribe, never a service call), waits until
// connected, and THEN deliberately points BASE_URL at an unreachable local
// port and force-closes the existing socket via hass.socket.teardown() (a
// normal client-side disconnect -- this does not restart or otherwise touch
// the user's HA instance). This exercises the *ongoing* reconnect state
// machine (documented in websocket-api.service.mts: a plain
// `scheduler.setInterval(manageConnection, RETRY_INTERVAL * SECOND)` loop,
// default 5s, with no exponential backoff) without ever sending HA a write.
// Finally BASE_URL is corrected back and recovery is observed.
import { CreateApplication } from "@digital-alchemy/core";
import type { TServiceParams } from "@digital-alchemy/core";
import { LIB_HASS } from "@digital-alchemy/hass";

const REAL_BASE_URL = Bun.env.HASS_BASE_URL;
if (!REAL_BASE_URL) {
  throw new Error("HASS_BASE_URL missing from environment/.env");
}

let params: TServiceParams | undefined;
const app = CreateApplication({
  name: "s3_reconnect_live",
  libraries: [LIB_HASS],
  services: {
    Loader(p: TServiceParams) {
      params = p;
    },
  },
});

await app.bootstrap();
const { hass, internal, logger } = params!;
console.log("[reconnect-live] connected. connectionState:", hass.socket.connectionState);

console.log("[reconnect-live] pointing BASE_URL at an unreachable local port and closing the socket...");
internal.boilerplate.configuration.set("hass", "BASE_URL", "http://127.0.0.1:65535");
await hass.socket.teardown();
console.log("[reconnect-live] connectionState immediately after teardown:", hass.socket.connectionState);

console.log("[reconnect-live] waiting 12s to observe scheduled retry attempts against the bad endpoint (RETRY_INTERVAL default = 5s, no backoff expected)...");
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 2_000));
  console.log(`[reconnect-live] t+${(i + 1) * 2}s connectionState:`, hass.socket.connectionState);
}

console.log("[reconnect-live] correcting BASE_URL back to the real instance...");
internal.boilerplate.configuration.set("hass", "BASE_URL", REAL_BASE_URL);

console.log("[reconnect-live] waiting up to 10s for automatic recovery...");
let recovered = false;
for (let i = 0; i < 5; i++) {
  await new Promise(r => setTimeout(r, 2_000));
  const state = hass.socket.connectionState;
  console.log(`[reconnect-live] t+${(i + 1) * 2}s connectionState:`, state);
  if (state === "connected") {
    recovered = true;
    break;
  }
}
console.log("[reconnect-live] recovered automatically:", recovered);

await app.teardown();
process.exit(0);
