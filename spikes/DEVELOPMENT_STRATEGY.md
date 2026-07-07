# Flowbun (working title)

A flow-based home automation runtime: functional core, TypeScript everywhere, Bun processes per flow, Workers per block, plaintext-on-disk as the single source of truth, and a browser editor that is just another client of the coordinator.

This document is (1) a summary of every decision made so far, and (2) a proof-of-concept plan structured around the unknowns, so that the variable-time portions of the project are spiked first and everything downstream of them is routine construction.

---

## Part 1 — Summary of decisions

### Motivation

Node-RED's virtues: it feels largely functional (pure-ish transformations, copy-on-write messages), it has a pleasant browser UI, and its Home Assistant integration is good. Its sins: effects and functions are not properly segregated, the palette is full of programming primitives ("switch", "change") that are better expressed as code, flows live in an opaque JSON blob rather than IDE-friendly plaintext, and reusing logic is awkward. HASS-native automations are worse to work with. Digital Alchemy proves the "typed TS against your actual HA instance" experience is excellent, but it has no visual layer.

The synthesis: a small FBP-style runtime where blocks are pure(-ish) async TypeScript functions, wiring is data, effects live at the boundary, and the visual editor is optional sugar over plaintext files.

### Architecture (as agreed)

**Topology.** One Docker/Podman container. A parent Bun **coordinator** process supervises everything: one Bun **flow-host process per flow**, one **Worker per block instance** inside its flow host, plus a separate long-lived Bun process serving the **editor** web app. The browser talks to the coordinator over websocket. Isolation granularity is a deployment knob in principle (function call / Worker / process), but the PoC default is exactly: process-per-flow, worker-per-block.

**Effects at the boundary.** Only the coordinator holds the Home Assistant connection, reusing `@digital-alchemy/hass` (referred to as DA). HA triggers and HA actions are coordinator-provided block types; entity events flow coordinator → flow host → workers, and service calls flow back the same path. User blocks physically cannot reach HA — the capability is never injected. However, blocks are deliberately *not* sandboxed from the wider world: calling an arbitrary third-party API with `fetch` inside a block is explicitly supported and expected to be pleasant (a stated Node-RED pain point). FBP-purity is the encouraged style, not a straitjacket. Power, responsibility, etc.

**Data directory** (bind-mounted into the container):

```
data/
  blocks/            # one .ts file per block type — pure TypeScript
  wiring/            # one <some_cool_flow>.json per flow
  state/             # flowbun.sqlite (WAL) — block/flow/global state
  generated/         # typecheck glue, HA generated types (git-ignorable)
```

**Blocks.** A block file exports named, typed inputs and outputs and an async process function. Everything is async. Blocks receive `(inputs, ctx)` where `ctx` carries the three state scopes and a logger — and nothing else. Example shape:

```ts
// data/blocks/debounce.ts
import { defineBlock } from "flowbun";

export default defineBlock({
  name: "debounce",
  config: { ms: 30_000 },
  inputs:  { signal: {} as { state: string; at: number } },
  outputs: { stable: {} as { state: string } },
  async process({ signal }, ctx) {
    const last = await ctx.state.block.get<number>("lastAt");
    // ... pure-ish logic; timers via ctx utilities
    await ctx.state.block.set("lastAt", signal.at);
    return { stable: { state: signal.state } };
  },
});
```

**Wiring.** JSON per flow in `wiring/`, human-diffable, the single source of truth. The editor writes these files; VS Code writes these files; the runtime only ever reads them.

```json
{
  "name": "hallway_lights",
  "nodes": {
    "motion":  { "block": "@hass/trigger", "config": { "entity": "binary_sensor.hallway_motion" } },
    "settle":  { "block": "debounce",      "config": { "ms": 30000 } },
    "decide":  { "block": "presence_logic" },
    "lights":  { "block": "@hass/action" }
  },
  "wires": [
    ["motion.changed", "settle.signal"],
    ["settle.stable",  "decide.presence"],
    ["decide.command", "lights.call"]
  ]
}
```

**Type strategy (two-tier trust).** Our own blocks and wiring are *compile-time* checked on boot and on every reload: the coordinator generates a synthetic TypeScript file per flow that imports the real block modules and asserts each wire's source-output type is assignable to its destination-input type, then runs `tsc --noEmit --incremental` over it. If it fails, the old flow keeps running and the error is pushed to the editor. Having passed, wires need no runtime validation. *Untrusted* boundaries — HA event payloads, third-party API responses — are validated at runtime with Zod inside the boundary blocks (and available to user blocks that want it).

**State.** Three scopes — per block instance, per flow, global — backed by `bun:sqlite` in WAL mode. Not strictly functional; extremely practical. State lives outside the workers, so it survives block reloads and flow restarts. Copy-on-write for messages is `structuredClone` at every hop (free where a hop is already a Worker/IPC boundary, explicit for any in-process hop).

**Reload.** Watch `blocks/` and `wiring/` (mtime-based with debounce, per the original suggestion; `fs.watch` if it proves reliable on the bind mount). Reload unit is the flow: typecheck → restart affected flow processes → state rehydrates from SQLite. No per-block hot-swap in v1; flow restarts are tens of milliseconds on Bun, so restarting is cheaper than being clever.

**Editor.** Separate Bun process serving a React app: React Flow canvas rendering the wiring files, live-updating via websocket; drag-to-rewire/add/remove with write-back to JSON; a sidebar palette of blocks discovered from `blocks/`; Monaco for editing block source in the browser. **Debug output ships in the PoC**: message traces and logs are piped coordinator → websocket → browser, initially just dumped to the browser devtools console, panel UI later. Explicitly cut from PoC: subflows, undo stack, multi-user, message-injection UI.

**Out of scope, permanently or for now:** migration/import of existing Node-RED or HASS automations (they will be re-authored by hand); auth on the editor (LAN-only assumption for PoC); clustering.

---

## Part 2 — The plan

### Philosophy: spend time only where the unknowns are

The known work — routers, file watchers, JSON schemas, React scaffolding, Dockerfiles — is fast to produce and cheap to verify. The schedule risk lives entirely in a handful of unknowns: places where library behavior can't be assumed from documentation and must be observed. So the plan front-loads those as **spikes**: each is a tiny throwaway program with a pass/fail question and a pre-committed fallback. Once the spikes have answers, every later phase is assembly of known-good parts, and the fallbacks mean no spike result can sink the design — only bend it.

### Phase 0 — Spikes (the unknowns, each with a fallback)

**S1. Bun Worker maturity — the load-bearing unknown.** Worker-per-block rests on Bun's `Worker`, historically the less-mature corner of Bun's Node compatibility. Questions: memory per idle worker (with and without `smol`); postMessage/structuredClone fidelity for our message shapes; clean `terminate()` and restart behavior in a loop (leak check over a few hundred cycles); behavior when a worker throws or infinite-loops; whether `bun:sqlite` can even be *loaded* in a worker (we don't need it there, but need to know it doesn't crash). Build: one flow host spawning 25 trivial echo workers, hammer it, measure RSS, kill/restart repeatedly. **Fallback:** blocks run in the flow-host process as plain async calls with explicit `structuredClone` at hops — the transport-interface design means this is a config default change, not a redesign. Isolation drops to per-flow, which was the crash boundary that mattered anyway.

**S2. Coordinator ↔ flow-host IPC.** `Bun.spawn` with `ipc` between Bun parent and Bun child: verify structured message round-trips, what happens to in-flight messages on child crash, whether the parent gets a reliable exit signal for supervision, and throughput sanity (target: thousands of msgs/sec, which is orders of magnitude beyond home-automation load). **Fallback:** newline-delimited JSON over stdio, or a localhost `Bun.serve` websocket per child. All three are boring; pick whichever behaves.

**S3. DA hass outside a full DA application.** We want `@digital-alchemy/hass` as a library inside the coordinator without adopting DA's whole application-wiring worldview. Questions: can `CreateApplication({ libraries: [LIB_HASS] })` be bootstrapped headlessly and expose entity subscriptions + service calls to our own code cleanly; does `type-writer` run happily against the live HA instance from outside a DA template repo; how does the websocket behave across HA restarts (reconnect/backoff). **Fallback:** `home-assistant-js-websocket` (the library the HA frontend itself uses) for the connection, keeping DA's `type-writer` output purely as ambient types for authoring. We lose some DA ergonomics, keep the typed-against-your-instance experience.

**S4. Typecheck-on-reload latency.** Generate the synthetic wire-assertion file for a fake 30-block flow and measure cold and `--incremental` warm `tsc --noEmit` inside the container. Target: warm check under ~2s so save-to-reload feels snappy. **Fallback:** typecheck asynchronously — reload optimistically, surface type errors to the editor as they arrive; or scope the check to changed flows only (which we'd do anyway).

**S5. SQLite across processes.** `bun:sqlite` WAL database opened by coordinator and multiple flow hosts concurrently: verify busy-timeout behavior and no corruption under concurrent writes. **Fallback:** coordinator owns the only connection; state ops become IPC calls (S2 transport). At home-automation rates this costs nothing.

**S6. File watching on a bind mount under Podman/Fedora.** `fs.watch` on bind-mounted volumes is notoriously environment-dependent (inotify may not propagate). Test on the actual target machine. **Fallback:** mtime polling every ~1s — which was the original instinct anyway, and is completely adequate.

Everything in Phase 0 is throwaway code. The deliverable is a filled-in decision table, not software.

### Phase 1 — Core runtime, headless, in-process

Build the engine with the *simplest* transport (plain async calls + structuredClone) so the logic is debuggable before distribution enters the picture: `defineBlock` and its types; block discovery/loading from `blocks/`; wiring loader + Zod schema for the JSON format; the router (per-input mailboxes, sequence numbers, trace IDs stamped at ingress); the three-scope state API over SQLite; the typecheck pipeline from S4; the HA boundary blocks (`@hass/trigger`, `@hass/action`) using the S3 answer. Milestone: **a real automation runs headless** — motion sensor → debounce → presence logic → light, defined entirely in `data/`, with a trace of the message path in the coordinator log. Also in this phase: a second demo block that calls an arbitrary external API with Zod on the response, to prove the "flexible, not dogmatic" requirement early.

### Phase 2 — Distribution and supervision

Introduce the real topology using S1/S2 answers: flow-host processes spawned per wiring file; workers per block (or the S1 fallback); a small supervisor in the coordinator (restart with exponential backoff, crash-loop detection, flow status states: running / degraded / failed-typecheck / crashed); reload pipeline (watcher → debounce → typecheck → restart flow → rehydrate state); structured log/trace events flowing child → coordinator over IPC into a ring buffer. Milestone: `kill -9` a flow host and watch it self-heal with state intact; corrupt a block's types and watch the old flow keep running while the error is reported.

### Phase 3 — Editor

The websocket control API on the coordinator first (subscribe: flows, block palette, logs/traces, status; commands: write wiring file, write block file, restart flow) — designed so the editor is a *pure client* with no privileged access; anything it can do, a curl script can do. Then the web app in this order: (1) read-only React Flow canvas rendered from wiring, live-updating when files change on disk — this alone is a huge quality-of-life milestone; (2) debug piped to the browser: trace and log events dumped to devtools console via the websocket (PoC requirement), upgraded to a simple filterable panel if time is cheap; (3) write-back editing — drag to rewire, add node from palette, delete, config editing, saving to the JSON files (round-trip fidelity test: editor save must produce a minimal git diff); (4) Monaco pane editing `blocks/*.ts` with save-triggers-reload, showing typecheck errors returned over the websocket. The frontend design should be intentional rather than default-Bootstrap-ish, but polish is explicitly last.

### Phase 4 — Packaging and the acid test

Dockerfile (`oven/bun` base, two entrypoint processes under the coordinator), compose file that slots next to the existing HA container (host-networking caveats from earlier in this conversation documented), `HASS_BASE_URL`/`HASS_TOKEN` via env, README covering block authoring and wiring format. Acid test: port **one real automation each** from the existing HASS-native set and the existing Node-RED set, by hand, and live with them for a while. The PoC verdict is whether authoring them felt better than what they replaced.

### Suggested repo layout

```
flowbun/
  packages/
    runtime/        # defineBlock, router, state, typecheck, transports
    coordinator/    # supervisor, HA boundary, ws control API, watcher
    flow-host/      # child-process entrypoint, worker management
    editor/         # Bun server + React app (React Flow, Monaco)
  data/             # the mounted directory (examples committed)
  spikes/           # Phase 0 artifacts, kept for reference
  Dockerfile
  compose.yaml
```

### Risk register

| # | Risk | Signal | Mitigation / fallback |
|---|------|--------|----------------------|
| 1 | Bun Workers leak or misbehave | S1 | In-process blocks per flow (transport knob) |
| 2 | Bun.spawn IPC unreliable | S2 | stdio JSON lines or localhost WS |
| 3 | DA hass resists headless embedding | S3 | home-assistant-js-websocket + DA type-writer types only |
| 4 | tsc reload latency annoying | S4 | Incremental + per-flow scope + async reporting |
| 5 | SQLite multi-process contention | S5 | Coordinator-owned connection, state over IPC |
| 6 | fs.watch dead on bind mount | S6 | mtime polling (original plan anyway) |
| 7 | Editor write-back mangles files | Phase 3 | Canonical JSON serializer; round-trip diff test in CI |
| 8 | Scope creep toward platform-building | Ongoing | Acid-test automations defined up front; features must serve them |
| 9 | Unknown unknowns | By definition | Transport/typecheck/state behind interfaces; every risky dependency has a boring substitute |

### What "done" means for the PoC

The container runs on the Fedora box next to HA. Two real automations (one ex-HASS, one ex-Node-RED) run from plaintext files in `data/`, survive flow crashes and machine reboots with state intact, hot-reload on save from VS Code, render and edit correctly in the browser canvas, and stream their message traces to the browser console. Nothing else is required for the verdict.

