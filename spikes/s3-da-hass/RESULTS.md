# S3: DA hass outside a full DA application

## Question
Can `@digital-alchemy/hass` be embedded as a plain library in a Bun script DA didn't scaffold, and still get clean entity subscriptions + structural service-call capability?

## Method
Installed `@digital-alchemy/hass` (26.6.13) and `@digital-alchemy/type-writer` (26.2.12, devDependency) into a bare `bun init -y` project — no DA CLI scaffolding, no other DA libraries. Read the installed package's `src`/`dist` to find the real bootstrap surface rather than guessing.

The actual minimal bootstrap is exactly what the package's own README documents:

```ts
import { CreateApplication } from "@digital-alchemy/core";
import { LIB_HASS } from "@digital-alchemy/hass";

const app = CreateApplication({ name: "my_app", libraries: [LIB_HASS], services: { ... } });
await app.bootstrap();
```

DA ships an even more minimal helper purpose-built for this exact scenario: `QuickBoot(name)`, exported from `@digital-alchemy/hass`'s main entry (`src/quickboot.module.mts`), explicitly commented `"Use from the node command line to probe apis. Not for normal application usage."`. It internally does the same `CreateApplication`/`bootstrap` dance and hands back the fully-wired `TServiceParams` (`{ hass, lifecycle, ... }`). `subscribe.ts` and `discover.ts` use this directly.

Config (`HASS_BASE_URL` / `HASS_TOKEN`) loads automatically: Bun auto-loads `.env` into `process.env` (confirmed via `bun init`'s `[0.01ms] ".env"` trace line), and DA's own config loader (`ConfigLoaderEnvironment` + `loadDotenv`) re-reads `.env` on every bootstrap with `dotenv.config({ override: true })`, then matches `hass.BASE_URL`/`hass.TOKEN` against `HASS_BASE_URL`/`HASS_TOKEN` (project-name + key, single underscore) — exactly the README's documented format. No manual .env parsing was needed.

Files: `discover.ts` (read-only entity listing), `subscribe.ts` (state read + subscribe, the deliverable proof point), `reconnect-test.ts` and `reconnect-live-test.ts` (reconnect probes), all in this directory.

## Results

- **Headless bootstrap without full DA scaffolding: PASS.** Minimal setup required: `bun add @digital-alchemy/hass` + a `.env` with `HASS_BASE_URL`/`HASS_TOKEN`. No config files, no other DA libraries, no particular directory layout. `CreateApplication({ libraries: [LIB_HASS], services: {...} })` (or DA's own `QuickBoot` helper) bootstraps in ~50-150ms from a single plain `.ts` file.

- **Clean entity state read/subscribe against live instance: PASS.** Used `sensor.ebusd_global_uptime` (a monotonic uptime counter, in seconds, from the household boiler controller — non-personal, and definitionally read-only by HA's `sensor.*` convention). `hass.entity.getCurrentState(id)` and `hass.refBy.id(id)` both returned live data immediately after boot (initial read: `"538466"`). Subscribing via `hass.refBy.id(id).onUpdate(...)` produced two real state-change events during an 18s window: `538482 → 538498 → 538514`, each ~16s apart, confirming a genuinely live websocket event stream, not cached/static data. `discover.ts` additionally enumerated all 532 `sensor.*` entities on the instance read-only (via `hass.entity.listEntities("sensor")` + `getCurrentState`) to pick a safe target.
  - Structural (not invoked) service-call surface: `hass.call` is a `Proxy` built at `onBootstrap` from `hass.configure.getServices()` (the instance's live `/api/services` list) — confirmed by trace logs enumerating real domains/services (`switch.turn_on`, `light.turn_on`, `lock.*`, etc.) from the actual instance. This proxy was observed being populated; **no property on it was ever invoked** (no `hass.call.*(...)` call was made, and no `ref.turn_on()`-style call on any `refBy` entity reference was made).

- **Reconnect/backoff behavior: tested directly (two scenarios).**
  1. *Bad URL at initial boot* (`reconnect-test.ts`, `--hass_BASE_URL=http://127.0.0.1:65535`): the websocket layer's own retry loop never got a chance to run — the `PostConfig`-phase REST prefetch of all entities (`hass.entity.refresh()` → `hass.fetch.getAllEntities()`) threw an uncaught connection error that propagated up through the lifecycle and triggered DA core's top-level `catch`, which logs `fatalLog("bootstrap failed", error)` and calls `process.exit(1)`. So: **a dead endpoint at boot time is fail-fast, not retried** — no hang, but no resilience either.
  2. *Connection drop after a successful boot* (`reconnect-live-test.ts`): boot succeeded against the real instance, then BASE_URL was pointed at an unreachable local port and the live socket was force-closed client-side (`hass.socket.teardown()` — a normal client disconnect, HA itself untouched). Observed: `connectionState` went `connected → offline`, then the scheduled `manageConnection` loop (`scheduler.setInterval(manageConnection, RETRY_INTERVAL * SECOND)`, default `RETRY_INTERVAL = 5s`) retried at t≈5s and t≈10s, each attempt logging `socket error` / `connection closed` and staying `offline` — a flat 5s-interval retry with **no exponential backoff, no jitter, no cap on attempts**. After correcting BASE_URL back to the real value, the very next scheduled tick reconnected automatically (`offline → connecting → connected` within ~5s), with no manual re-subscription needed (subscriptions are tracked in a registry and auto re-sent via an internal `onConnect` hook).
  - Also inspected from source (`websocket-api.service.mts`): a stalled/unresponsive-but-still-open connection is detected via a ping/pong dead-man's-switch (`handleUnknownConnectionState`, using `EXPECT_RESPONSE_AFTER`/`RETRY_INTERVAL`) that eventually tears down and re-enters the same fixed-interval retry loop.

- **type-writer outside a DA template repo: PASS**, with one caveat. Ran `./node_modules/.bin/type-writer` (installed via `bun add -D`) directly. It bootstrapped `LIB_HASS` + its own `LIB_TYPE_BUILD` against the live instance using the same `.env`, no other scaffolding — first run failed only because its default `TARGET_DIR` (`src/hass`) didn't exist yet (`mkdirSync` isn't recursive: `ENOENT`). After `mkdir -p src/hass`, it succeeded: fetched the live registry/services and wrote `mappings.mts`, `registry.mts`, `services.mts` (~42k lines total) in ~1.5s, with only benign warnings about a few integrations reusing the same `unique_id` across domains. Its `bin` (`scripts/run.sh`) shells out to `npx tsx src/main.mts` — needs `npx`/npm on PATH (present here) and fetched `tsx` on the fly since it's only a `devDependency` of `type-writer` itself, not a transitive `dependency`. The only missing piece for a bare project was the pre-existing target directory.

## Verdict
**PASS** (DA hass embeds cleanly as a library) — with a boot-time robustness caveat: production code built this way should either pre-flight the connection (or catch/retry the boot itself) before relying on DA's internal reconnect logic, since that logic only engages after a first successful boot.

## Notes
- Versions: `@digital-alchemy/hass@26.6.13`, `@digital-alchemy/core@26.x` (resolved as a peer dep automatically by `bun add`), `@digital-alchemy/type-writer@26.2.12`, Bun 1.3.13.
- Surprising: DA ships `QuickBoot` itself specifically for "probe the API from a script" use — this is direct upstream acknowledgment that the exact pattern this spike wanted (library-only, no full app) is a supported, if informally-blessed, mode of use.
- Write-capable surface deliberately **not** exercised: `hass.call.<domain>.<service>(...)` (the service-call proxy) and any `refBy(...).turn_on()`/`.turn_off()`/property-`set` style calls (the `ByIdProxy`'s `set` trap on `state`/`attributes` issues a REST write) — confirmed present and structurally correct by reading `call-proxy.service.mts` and `reference.service.mts`, never invoked.
- The generated `type-writer` output (`src/hass/{mappings,registry,services}.mts`) was deleted after confirming success — it's a full dump of the live instance's entity/device/area registry (hundreds of entities, all device names) and isn't needed for this spike's deliverable; regenerate with `mkdir -p src/hass && ./node_modules/.bin/type-writer` if needed again.
- `.env` was never read directly by any script/tool call in this session (only `cut -d= -f1 .env` to confirm key *names*); `HASS_TOKEN`'s value was never printed, logged, or written to disk by any script. All scripts print only `Bun.env.HASS_BASE_URL`.
- `bun init -y` and `bun add` were run only inside `spikes/s3-da-hass/`; the repo-root `flowbun/package.json` and its lockfile were not touched.
