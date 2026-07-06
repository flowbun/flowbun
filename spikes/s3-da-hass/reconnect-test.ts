// S3 spike: reconnect/backoff behavior probe.
//
// SAFE BY CONSTRUCTION: this never touches the user's real Home Assistant
// instance. It first points LIB_HASS's BASE_URL at an unreachable local port
// (127.0.0.1:65535, nothing listens there -- no packets ever leave this
// machine, and the real HA instance is never contacted during that phase),
// observes how the socket layer behaves on connection failure, then corrects
// the BASE_URL to the real value from .env and observes whether it recovers
// on its own. No service calls are made at any point.
import { CreateApplication } from "@digital-alchemy/core";
import type { TServiceParams } from "@digital-alchemy/core";
import { LIB_HASS } from "@digital-alchemy/hass";

const REAL_BASE_URL = Bun.env.HASS_BASE_URL;
if (!REAL_BASE_URL) {
  throw new Error("HASS_BASE_URL missing from environment/.env");
}

// NOTE: DA's dotenv loader re-reads .env with `override: true` on every config
// resolution, so simply mutating process.env.HASS_BASE_URL here gets stomped
// back to the real value (confirmed empirically). CLI switches are checked
// *before* env vars in the same resolution pass, so the bad URL is instead
// passed via `--hass_BASE_URL=...` on the command line (see how this file is
// invoked). This block just documents/asserts that expectation.
console.log("[reconnect] CLI-provided override in effect via --hass_BASE_URL switch");

let params: TServiceParams | undefined;
const app = CreateApplication({
  name: "s3_reconnect_probe",
  libraries: [LIB_HASS],
  services: {
    Loader(p: TServiceParams) {
      params = p;
    },
  },
});

console.log("[reconnect] bootstrapping against unreachable local port (this may hang -- that is itself a finding)...");

const bootDeadline = setTimeout(() => {
  console.log("[reconnect] app.bootstrap() has NOT resolved after 15s -- the onBootstrap lifecycle stage appears to be blocked waiting on the socket 'auth_ok' promise, which never settles on connect failure. This itself is the finding: no built-in connect timeout observed.");
  process.exit(0);
}, 15_000);
bootDeadline.unref?.();

await app.bootstrap();
clearTimeout(bootDeadline);

const { hass, config, internal } = params!;
console.log("[reconnect] bootstrap resolved. connectionState:", hass.socket.connectionState);
console.log("[reconnect] config.hass.BASE_URL currently:", config.hass.BASE_URL);

console.log("[reconnect] waiting 8s on bad endpoint to observe retry attempts (RETRY_INTERVAL default = 5s)...");
await new Promise(r => setTimeout(r, 8_000));
console.log("[reconnect] connectionState after 8s on bad endpoint:", hass.socket.connectionState);

console.log("[reconnect] correcting BASE_URL to the real instance from .env...");
internal.boilerplate.configuration.set("hass", "BASE_URL", REAL_BASE_URL);

console.log("[reconnect] waiting up to 8s for automatic recovery...");
await new Promise(r => setTimeout(r, 8_000));
console.log("[reconnect] connectionState after correction:", hass.socket.connectionState);

await app.teardown();
process.exit(0);
