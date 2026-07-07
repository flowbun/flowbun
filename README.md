# Flowbun

A flow-based home automation runtime: functional core, TypeScript everywhere, Bun processes per flow, Workers per block, plaintext-on-disk as the single source of truth, and a browser editor that is just another client of the coordinator.

> **This project is heavily AI-written.** The architecture was planned and the vast majority of the code, tests, and documentation (including this file) were produced by an AI coding agent (Claude), working from a human-authored design brief and under human review at each phase. Treat it accordingly: read the code before trusting it, and expect the seams of AI-driven development — very consistent style, thorough inline rationale, and occasional over-engineering in places a human might have cut a corner. (Note from aquarat: this is a fun self-reflection)

## Why this exists

(aquarat) [Node-RED](https://nodered.org/) is great - I've used it extensively for all kinds of automation, home and otherwise. But Node-RED has a number of deficiencies (as far as I'm concerned).

(aquarat) I find myself wanting to code a bunch of function blocks in Node-RED rather than using the discrete logic blocks (eg. "Switch"), and in those blocks I want type-safety, both inside those blocks but also the inputs and outputs on those blocks. I've encountered a number of scenarios where Node-RED has crashed, so I'd like increased process-level segregation. I've compromise here on process-per-flow rather than per block. I like the idea of an alternative runtime to NodeJS and my experiences with Bun have been great - so this is a Bun-based project.

[Node-RED](https://nodered.org/) gets a lot right: flows are mostly pure(-ish) data transformations wired together, messages are copy-on-write, and its Home Assistant integration is good. But it has real problems: effects and pure functions aren't segregated, the palette is full of programming primitives ("switch", "change") that are just better expressed as code, flows live in an opaque JSON blob that fights version control and IDEs, and reusing logic across flows is awkward.

[Digital Alchemy](https://github.com/Digital-Alchemy-TS) proves the alternative — typed TypeScript against your actual Home Assistant instance — is a genuinely nice experience. But it has no visual layer, and hand-rolled automations lose the at-a-glance topology a flow graph gives you.

Flowbun is the synthesis: a small [flow-based programming](https://en.wikipedia.org/wiki/Flow-based_programming)-style runtime where blocks are pure(-ish) async TypeScript functions, wiring is data (plain JSON, human-diffable, git-friendly), effects live strictly at the boundary, and the visual editor (not yet built — see [Status](#status)) is optional sugar over the same plaintext files a human or an IDE can edit directly.

## Status

This repo is a proof-of-concept, built in phases:

- **Phase 0 — spikes** (done): six throwaway experiments answering the risky unknowns before committing to an architecture — Bun `Worker` behavior under load, `Bun.spawn` IPC, `@digital-alchemy/hass` embedded outside a full DA app, typecheck-on-reload latency, multi-process SQLite, and `fs.watch` on a container bind mount. Full writeups and measured evidence are in [`spikes/`](spikes/), rolled up in [`spikes/DECISIONS.md`](spikes/DECISIONS.md).
- **Phase 1 — headless core runtime** (done): the actual engine — `defineBlock`, block discovery, the wiring format, the router, three-scope state, the typecheck gate, and the Home Assistant boundary blocks — running in a single process with the simplest possible transport (plain async calls). This is what's in [`packages/runtime`](packages/runtime) today, exercised by the example flows in [`data/`](data).
- **Phase 2 — distribution and supervision** (not started): the real topology — a coordinator process supervising one flow-host process per flow, one Worker per block, crash recovery, hot reload.
- **Phase 3 — editor** (not started): a browser UI (React Flow + Monaco) that reads and writes the same wiring/block files, live over a websocket.
- **Phase 4 — packaging** (not started): containerization, and porting one real automation each from an existing Node-RED and HASS-native setup as the acid test.

Everything described below as "the runtime" is Phase 1: real, tested code, but running in-process with no isolation between blocks yet. The full multi-process/multi-Worker topology described in [Architecture](#architecture) is the target, not (yet) the implementation.

## Repo structure

```
flowbun/
  packages/
    runtime/            # the "flowbun" package — defineBlock, router, state, typecheck
      src/
        block.ts          # defineBlock + the BlockDef/BlockContext types every block is written against
        discovery/          # scans data/blocks/*.ts and registers the built-in @hass/* blocks
        wiring/               # Zod schema for wiring JSON, the loader, and flow assembly
        router/                 # message routing: mailboxes, sequence numbers, trace IDs
        state/                    # the three-scope state API over bun:sqlite
        typecheck/                  # generates and runs the synthetic wire-assertion file (see below)
        hass/                         # the only code allowed to talk to Home Assistant
        demo/                           # the headless milestone runner
  data/                 # a real flowbun "data directory" — what would be bind-mounted in production
    blocks/               # one .ts file per block type, written against `flowbun`
    wiring/                 # one <flow-name>.json per flow — the actual source of truth
    state/                    # flowbun.sqlite (gitignored) — created at runtime
    generated/                  # typecheck glue (gitignored) — regenerated on every load
  spikes/               # Phase 0 throwaway experiments, kept for reference — not maintained code
```

A quirk worth explaining: the root `package.json` is named `flowbun-workspace`, not `flowbun` — the actual `flowbun` package (the one `data/blocks/*.ts` files `import { defineBlock } from "flowbun"` against) is `packages/runtime`. Bun workspaces symlinks it in, but only because the root package explicitly depends on it (`"flowbun": "workspace:*"`) — the root package needing to *consume* its own workspace member is what forces the naming split.

## Architecture decisions, and why

### Blocks are pure(-ish) async functions, not a DSL

A block is a plain TypeScript module: named typed inputs, named typed outputs, an async `process` function, three scopes of persistent state, and nothing else injected. No special control-flow primitives, no proprietary expression language — if you need a switch statement, you write a switch statement. This is the direct rejection of Node-RED's palette of "switch"/"change"/"function" nodes: those are just programming, so let them be programming.

```ts
// data/blocks/debounce.ts
import { defineBlock } from "flowbun";

export default defineBlock({
  name: "debounce",
  config: { ms: 30_000 },
  inputs: { signal: {} as { state: string; at: number } },
  outputs: { stable: {} as { state: string } },
  async process({ signal }, ctx) {
    const last = await ctx.state.block.get<number>("lastAt");
    if (last !== undefined && signal.at - last < ctx.config.ms) return;
    await ctx.state.block.set("lastAt", signal.at);
    return { stable: { state: signal.state } };
  },
});
```

### Wiring is plaintext JSON, not a database or a binary blob

Each flow is one `.json` file in `data/wiring/` — a `name`, a map of `nodeId -> {block, config}`, and a list of `["node.port", "node.port"]` wires. This is the single source of truth: the (eventual) editor writes it, an IDE can edit it directly, and it diffs cleanly in git. The runtime only ever *reads* it. Node-RED's flows being an opaque, hard-to-diff JSON blob was one of the original motivating complaints — the fix is making the format itself something a human would willingly hand-edit.

### Two-tier trust: compile-time for us, runtime validation at the boundary

Wires between our own blocks are checked once, at load time, by generating a synthetic TypeScript file that imports every real block module in the flow and asserts each wire's source-output type is assignable to its destination-input type — then running `tsc --noEmit --incremental` over it. If it fails, the *old* flow keeps running and the error is reported; nothing partially starts. This technique was proven in the Phase 0 spikes (30 synthetic blocks, ~400ms warm checks) before being built for real in `packages/runtime/src/typecheck/`.

Anything crossing a genuine trust boundary — Home Assistant event payloads, third-party API responses — gets validated at runtime with [Zod](https://zod.dev/) instead, inside the boundary block. The `outdoor_temp` demo block is the concrete example: it calls an arbitrary external API with `fetch` and Zod-parses the response, because calling arbitrary third-party APIs is meant to be a first-class, pleasant thing to do in a block, not a workaround.

### Effects live strictly at the boundary

Only two block types can reach Home Assistant: `@hass/trigger` and `@hass/action`. Ordinary blocks import `defineBlock` (and whatever else they like — Zod, `fetch`, anything on npm) but are never handed a reference to the Home Assistant connection; the capability is simply never injected into their scope. This isn't a sandbox (a block *can* still shell out to any third-party API it wants — that's deliberate), it's a narrower guarantee: the one thing that can change the state of your physical house is confined to two well-known block types.

`@hass/action` also has a **dry-run mode** (`FLOWBUN_DRY_RUN`, defaulting to `"true"` — safe by default, a missing env var never accidentally enables real writes). In dry-run, it logs the exact service call it would have made instead of making it. This exists because Phase 1 was developed and demoed against a real, live Home Assistant instance, and the person doing that development wasn't ready for an AI-written runtime to start flipping real lights — dry-run made "prove the whole pipeline end-to-end, live" and "never actually write to the house" simultaneously true.

### Single-input firing, not join semantics

A block's `process()` fires once per message arriving at *one* named input port; the runtime only ever populates that one port, even if the block declares several. This is a deliberate simplification (documented loudly in `block.ts`) rather than an oversight: every block in this codebase has exactly one input, "wait for all ports to have a value" (join semantics) is a meaningfully different and more complex feature, and it's better to ship the simple version and let a block that genuinely needs cross-port memory use its own state (exactly how `debounce` remembers its last timestamp) than to build unneeded machinery speculatively.

### Three-scope state over SQLite, not in-memory

State is explicitly *not* purely functional — it's `bun:sqlite` in WAL mode, with per-block, per-flow, and global scopes sharing one `flowbun.sqlite` file, partitioned by a `(scope, scope_key, key)` primary key. State living outside the block's own memory means it survives block reloads and flow restarts — a debounce timer, a "have I already fired today" flag, and similar bookkeeping shouldn't evaporate every time you save a file and the flow hot-reloads. Multi-process concurrent access to one SQLite file was one of the Phase 0 spikes (setting `busy_timeout` collapsed contention errors from ~99.8% of writes to ~0.01% under a deliberately adversarial worst case, with no corruption or lost writes), so this is expected to keep working once Phase 2 introduces real multi-process flows.

### Messages are copy-on-write via `structuredClone`

Every hop between blocks clones the payload, even though Phase 1 runs entirely in one process and could get away with passing references. This is deliberate now, not added later: it keeps a block's mutation of its own inputs from ever silently corrupting a sibling branch's copy of the same message, and it means Phase 2 (where some of these hops become real process/Worker boundaries with unavoidable serialization) won't change block-author-visible behavior at all.

## Running it

```sh
bun install
cp spikes/s3-da-hass/.env .env   # or your own HASS_BASE_URL / HASS_TOKEN
bun run demo:hallway
```

This discovers the blocks in `data/blocks/`, validates and typechecks every flow in `data/wiring/`, then runs both example flows: `outdoor_temp_demo` (a real, Zod-validated fetch to a public weather API) and `hallway_lights` (a real, read-only subscription to a Home Assistant motion sensor, feeding `debounce → presence_logic → @hass/action`, with the final light command logged in dry-run rather than executed). Set `FLOWBUN_DEMO_WINDOW_MS` to change how long it listens (default 2 minutes; `0` runs until Ctrl-C), and `FLOWBUN_DRY_RUN=false` if you're ready to let it make real service calls.

See [`spikes/DECISIONS.md`](spikes/DECISIONS.md) for the Phase 0 evidence behind these choices, and the `RESULTS.md` in each `spikes/sN-*/` directory for the full detail behind each one.
