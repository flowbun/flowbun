<p align="center">
  <img src="images/flowbun-logo-full.jpg" alt="Flowbun logo: a cartoon loaf of bread flying out of a pipe" width="220">
</p>

# Flowbun

A flow-based home automation runtime: functional core, TypeScript everywhere, Bun processes per flow, Workers per block, plaintext-on-disk as the single source of truth, and a browser editor that is just another client of the coordinator.

> **This project is heavily AI-written.** The architecture was planned and the vast majority of the code, tests, and documentation (including this file) were produced by an AI coding agent (Claude), working from a human-authored design brief and under human review at each phase. Treat it accordingly: read the code before trusting it, and expect the seams of AI-driven development — very consistent style, thorough inline rationale, and occasional over-engineering in places a human might have cut a corner. (Note from aquarat: this is a fun self-reflection)

![The Flowbun editor: the block palette (core blocks and add-on blocks split into collapsible sections) on the left, a wired flow on the canvas, the chat panel open on the right mid-conversation with Claude about the current flow, and the live log panel filtered to one node's debug output along the bottom.](images/flowbun-fullflight.png)

## Why this exists

(aquarat) [Node-RED](https://nodered.org/) is great - I've used it extensively for all kinds of automation, home and otherwise. But Node-RED has a number of deficiencies (as far as I'm concerned).

(aquarat) I find myself wanting to code a bunch of function blocks in Node-RED rather than using the discrete logic blocks (eg. "Switch"), and in those blocks I want type-safety, both inside those blocks but also the inputs and outputs on those blocks. I've encountered a number of scenarios where Node-RED has crashed, so I'd like increased process-level segregation. I've compromise here on process-per-flow rather than per block. I like the idea of an alternative runtime to NodeJS and my experiences with Bun have been great - so this is a Bun-based project.

[Node-RED](https://nodered.org/) gets a lot right: flows are mostly pure(-ish) data transformations wired together, messages are copy-on-write, and its Home Assistant integration is good. But it has real problems: effects and pure functions aren't segregated, the palette is full of programming primitives ("switch", "change") that are just better expressed as code, flows live in an opaque JSON blob that fights version control and IDEs, and reusing logic across flows is awkward.

[Digital Alchemy](https://github.com/Digital-Alchemy-TS) proves the alternative — typed TypeScript against your actual Home Assistant instance — is a genuinely nice experience. But it has no visual layer, and hand-rolled automations lose the at-a-glance topology a flow graph gives you.

Flowbun is the synthesis: a small [flow-based programming](https://en.wikipedia.org/wiki/Flow-based_programming)-style runtime where blocks are pure(-ish) async TypeScript functions, wiring is data (plain JSON, human-diffable, git-friendly), effects live strictly at the boundary, and the visual editor is optional sugar over the same plaintext files a human or an IDE can edit directly — the editor has no privileged access; anything it can do, a `curl`/`websocat` script could do too.

## Status

This repo is a proof-of-concept, built in phases:

- **Phase 0 — spikes** (done): six throwaway experiments answering the risky unknowns before committing to an architecture — Bun `Worker` behavior under load, `Bun.spawn` IPC, `@digital-alchemy/hass` embedded outside a full DA app, typecheck-on-reload latency, multi-process SQLite, and `fs.watch` on a container bind mount. Full writeups and measured evidence are in [`spikes/`](spikes/), rolled up in [`spikes/DECISIONS.md`](spikes/DECISIONS.md).
- **Phase 1 — headless core runtime** (done): the actual engine — `defineBlock`, block discovery, the wiring format, the router, three-scope state, the typecheck gate, and the Home Assistant boundary blocks — running in a single process with the simplest possible transport (plain async calls). This is what's in [`packages/runtime`](packages/runtime), exercised by the in-process demo (`bun run demo:hallway`) and the example flows in [`data/`](data).
- **Phase 2 — distribution and supervision** (done): the real topology — a light-touch [`packages/coordinator`](packages/coordinator) process holding no Home Assistant connection of its own, one [`packages/flow-host`](packages/flow-host) child process per flow (each opening exactly one HA connection, shared internally by every Worker in that flow), one Worker per block instance, crash recovery with backoff/crash-loop detection, and a debounced real-`fs.watch` reload pipeline that typechecks before ever touching a running process. Verified live against a real HA instance: `kill -9`-ing a flow-host self-heals with state intact, a broken block type leaves every other flow untouched, and a dedicated test flow proved a real (non-dry-run) HA write end-to-end.
- **Phase 3 — editor** (done): a browser UI ([`packages/editor`](packages/editor), React Flow + Monaco) that is a pure client of a new websocket control API on the coordinator ([`flowbun/ws`](packages/runtime/src/ws/protocol.ts)). Built and verified in the order the design called for: a read-only live canvas that reflects on-disk wiring in real time, structured logs piped unconditionally to devtools, minimal-diff write-back editing (drag, config edits, add/remove nodes and wires), and Monaco-based block source editing with real `tsc` output surfaced live on save. Verified end-to-end with headless-browser automation (Playwright) against the real coordinator/flow-host topology, including a genuine concurrency bug (overlapping reloads from rapid successive edits) found and fixed this way.
- **Phase 4 — packaging** (demo container done, acid test partially done): a `Dockerfile` + entrypoint runs the coordinator, editor, and `ai-host` as sibling processes in one container (see [Running it](#running-it)). The acid test — porting a real automation from an existing HASS-native/Node-RED setup — is partly done: `battery_controller` is a real migration from a live Home Assistant YAML automation (its original form kept as a trailing comment in `data/blocks/battery_controller.ts` for comparison); a Node-RED-sourced migration is still outstanding.

"The runtime" below means [`packages/runtime`](packages/runtime) — the engine shared by every topology. Phase 1's in-process demo and Phase 2's distributed coordinator/flow-host/Worker topology both run the exact same `Router`, block format, and typecheck gate; they differ only in which `NodeExecutor` the `Router` is given (see [Architecture](#architecture)).

## Repo structure

```
flowbun/
  packages/
    runtime/            # the "flowbun" package — defineBlock, router, state, typecheck
      src/
        block.ts          # defineBlock + the BlockDef/BlockContext types every block is written against
        discovery/          # scans data/blocks/*.ts and registers the built-in @hass/*/@core/* blocks
        wiring/               # Zod schema for wiring JSON, the loader, and flow assembly
        router/                 # message routing: mailboxes, sequence numbers, trace IDs, the Executor seam
        state/                    # the three-scope state API over bun:sqlite
        typecheck/                  # generates and runs the synthetic wire-assertion file (see below)
        hass/                         # the only code allowed to talk to Home Assistant (@hass/trigger, @hass/action, @hass/read, and exposed-entities.ts's voice-assistant-exposure query)
        core/                           # built-in, non-HA blocks: @core/scheduler, @core/inject, @core/debug, @core/switch
        http/                           # @http/in — inbound-HTTP boundary block (serves from the flow's own process; kind: "duplex")
        ai/                               # @ai/agent's config/type surface (the SDK loop itself lives in packages/ai-host); @ai/openai_agent — a self-contained, no-ai-host-needed alternative that speaks any OpenAI-chat-completions-compatible API
        auth/                              # optional username/password + JWT session support, shared by coordinator + editor (see below)
        ipc/                                # message types shared across every process pair (coordinator<->flow-host, coordinator<->ai-host, flow-host<->Worker)
        ws/                                   # flowbun/ws — the websocket protocol shared with the browser editor
        demo/                                   # the in-process headless milestone runner (Phase 1)
    flow-host/          # one OS process per flow — the real topology's per-flow half, and the only place that holds that flow's Home Assistant connection
      src/
        main.ts            # entrypoint: assembles its one flow, opens the flow's one HA connection lazily, wires IPC to the coordinator
        worker-manager.ts     # persistent per-node Worker pool + its own micro-supervisor; answers each Worker's hass.read/hass.call relay
        worker-entry.ts          # the Worker-thread script: imports one block, runs its process(), relays HA reads/calls to its parent
        distributed-executor.ts    # NodeExecutor: Workers for ordinary nodes, IPC relay to the coordinator only for @ai/agent
    coordinator/        # the long-lived parent — light-touch: process supervision only, never touches Home Assistant or the Claude Agent SDK directly
      src/
        main.ts            # entrypoint: initial typecheck, spawns every flow (+ ai-host), starts the watcher, starts the ws server
        supervisor.ts         # spawn/restart/backoff/crash-loop/status per flow
        ai-host-client.ts       # spawns/talks to the ai-host child process (Bun.spawn IPC, same pattern as a flow-host)
        watcher.ts                 # debounced real fs.watch -> reload decisions
        log-buffer.ts                # bounded ring buffer for structured logs, with live subscribe/unsubscribe
        wiring-writer.ts               # minimal-diff wiring edits via jsonc-parser (see below)
        ws-server.ts                      # the flowbun/ws server: snapshot on connect, mutation commands, optional auth gate on "/ws"
        agent/                              # tool *implementations* the ai-host's MCP server calls back into over IPC (dispatch-tool-call.ts, tools.ts)
    ai-host/            # the dedicated process holding Claude credentials and running the Claude Agent SDK query() loop
      src/
        main.ts            # entrypoint: IPC to the coordinator, relays tool calls to it, streams chat events back
        agent/                # runner.ts (the query() loop), mcp-server.ts (the one capability surface), session-store.ts, auth.ts
    editor/             # the browser UI — a pure client of the coordinator's websocket API
      src/
        server.ts          # Bun native HTML-import dev server, /config.json, and (if auth is configured) /api/login,/api/session,/api/logout
        client/
          ws/FlowbunSocketContext.tsx  # the one websocket connection, request/response correlation, reducer
          devtools-console.ts            # every LogRecord unconditionally logged to devtools console
          layout/auto-layout.ts            # BFS longest-path layering for nodes with no saved position
          components/
            Auth/               # LoginGate.tsx — client-side gate around the socket connection when auth is configured
            Canvas/          # React Flow canvas: nodes/edges from wiring, drag/connect/delete -> mutations
            Palette/            # block palette: collapsible/resizable core-vs-add-on block sections
            LogPanel/              # live structured log viewer
            BlockEditor/              # Monaco block-source editing with live typecheck error surfacing
            StatusBar/                  # per-flow status badges (running/restarting/failed-typecheck/...)
            ChatPanel/                     # chat panel: session picker, markdown-rendered replies, tool-call pills
  data/                 # a real flowbun "data directory" — bind-mounted into the container, not baked in
    blocks/               # one .ts file per block type, written against `flowbun`
    wiring/                 # one <flow-name>.json per flow — the actual source of truth
    state/                    # flowbun.sqlite (gitignored) — created at runtime
    generated/                  # typecheck glue (gitignored) — regenerated on every load
  integrations/         # code that lives OUTSIDE this repo's own runtime, for other systems to install
    flowbun_conversation/ # a Home Assistant custom component: makes a flowbun flow (@http/in + friends) the conversation agent of an Assist voice pipeline
  spikes/               # Phase 0 throwaway experiments, kept for reference — not maintained code
  Dockerfile            # oven/bun base; bundles coordinator + editor into one image (data/ excluded — see below)
  docker-entrypoint.ts  # runs coordinator + editor as sibling processes; either dying kills the container
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

A small, well-known set of block types can reach Home Assistant: `@hass/trigger`, `@hass/action`, `@hass/read` — an on-demand snapshot read of any entity's live state *and* attributes, added once a flow needed something `@hass/trigger`'s watch-one-entity model couldn't give it (a sun-tracking blind controller needing `sun.sun`'s azimuth/elevation attributes on every scheduler tick, not just its coarse above/below-horizon state) — and `hass/exposed-entities.ts`'s `listExposedEntities()`, a read-only query (over the same one HA connection, via DA's own `hass.socket.sendMessage` websocket passthrough) for which entities a household has actually toggled on under Home Assistant's own "Voice assistants → Expose" setting. That last one exists for a very different reason than the others: it's not "read a value," it's "read the *curated* set of entities something is even allowed to act on" — deliberately distinct from `@ai/agent`'s own `hass_entities` MCP tool, which still lists *every* entity in the house (unfiltered by exposure). `@ai/openai_agent` calls `listExposedEntities()` directly, from its own `hass_list_entities` tool; `@ai/agent` gets the same curated set a different way, indirectly, through prompt-seeding rather than a tool call — the `voice-assist` registry package's `entity_directory` block polls it on a timer and caches the result in flow state, which any agent's prompt (Claude's or a local model's) is then seeded with, so a chat/voice agent tells a user the truth about what it can actually control instead of guessing from every entity in the house. Ordinary blocks import `defineBlock` (and whatever else they like — Zod, `fetch`, anything on npm) but are never handed a reference to the Home Assistant connection; the capability is simply never injected into their scope. This isn't a sandbox (a block *can* still shell out to any third-party API it wants — that's deliberate), it's a narrower guarantee: the one thing that can change the state of your physical house is confined to a small, well-known set of block types.

Three more built-in blocks reach a capability narrower than Home Assistant but still outside a block's own pure `process()`: `@core/scheduler` (interval/daily-time/sunrise-sunset-relative triggers — the timer lives entirely in the flow-host process, no coordinator involvement at all, since a timer isn't a shared external resource the way an HA subscription is), `@core/inject` (a manual fire button rendered directly on the node in the editor canvas — Node-RED's "inject" node — routed browser → coordinator → the owning flow-host over a small `flow.fireNode` request, deliberately restricted to firing only `@core/inject` nodes rather than any node by name), and `@core/debug` (Node-RED's "debug" node: JSON-serializes whatever's wired into it — gracefully, not by crashing, for the circular-reference/bigint values `JSON.stringify` itself can't handle — and logs it under its own node id, so the editor's Logs panel can filter straight down to just that node's traffic).

The Fire button is one instance of a small, general mechanism: `BlockDef`'s optional `control` field (`block.ts`) is a purely declarative, editor-facing hint — `{ kind: "fire" }` for `@core/inject`, `{ kind: "toggle", configKey, values, labels }` for `@core/switch` (a manual A/B router: forward whatever arrives on `input` to whichever of `a`/`b` is currently selected, letting two branches of a flow — e.g. two candidate implementations, or a Claude-backed agent vs. a local one — be compared live with a click instead of rewiring) — that `BlockNode.tsx` renders generically from, rather than special-casing each block by name. Nothing about what a control *does* is new: a toggle click is the exact same `node.config` wiring mutation the side-panel config editor already sends, just triggered from the node itself; a fire click is still gated by `@core/inject`'s own `fireable: true` exactly as before — `control` only decides what button (if any) the canvas draws.

`@http/in` reaches a fourth kind of boundary: the network, as a *listener* rather than a caller — an inbound HTTP server (`Bun.serve`, one per node, config'd with its own port/path/bearer-token) running inside the flow's own process, never the coordinator's, so one flow's endpoint hanging or crashing can't touch any other flow. It needs a genuinely new block kind, `"duplex"`, to express: a message can *arrive* at any time (like a source's `subscribe`/`emit`) while the flow must also be able to *answer back into that same request* (like a transform's `process()`) — a plain source-plus-transform pair can't do this, since the two would land in different Workers with no shared handle to the one open HTTP response. Both hooks run in the same Worker, so a pending-responses map keyed by request id, held in the block's own module scope, is what lets `process()` reach what `subscribe()` opened. This is the boundary primitive the `flowbun_conversation` Home Assistant integration (`integrations/`) is built on: it POSTs a transcribed voice utterance at a flow's `@http/in` node and waits for the reply to speak back through the same satellite.

`@hass/action` also has a **dry-run mode** (`FLOWBUN_DRY_RUN`, defaulting to `"true"` — safe by default, a missing env var never accidentally enables real writes). In dry-run, it logs the exact service call it would have made instead of making it. This exists because Phase 1 was developed and demoed against a real, live Home Assistant instance, and the person doing that development wasn't ready for an AI-written runtime to start flipping real lights — dry-run made "prove the whole pipeline end-to-end, live" and "never actually write to the house" simultaneously true. A single node can also override the global setting with a raw `"dryRun": false` in its own wiring config — deliberately *not* part of `@hass/action`'s typed config, so one flow can go live for real testing while every other flow on the same coordinator stays safely in dry-run. (The dedicated `flowbun_test` flow this override was originally proved out on was a scratch flow, since removed from `data/wiring/` now that `battery_controller` itself exercises non-dry-run writes for real — the override mechanism it demonstrated is unchanged.)

In the distributed topology (Phase 2), this boundary became a real process boundary, not just an API-surface convention — but the boundary sits at the *flow*, not at the coordinator. Each flow owns exactly one real Home Assistant connection, opened lazily the first time anything in that flow needs it, and it lives in that flow's own `flow-host` process — never in the coordinator, which holds no HA connection at all and never did anything more than supervise (spawn/restart/backoff/crash-loop) once Phase 2 landed. Flows are independent of each other and of the coordinator this way — each with its own connection, its own Workers, its own state — while still being *managed* by the coordinator (spawned, typechecked, restarted, watched). Concretely: `@hass/trigger` nodes don't even get a Worker — `flow-host/src/main.ts` subscribes them directly off the flow's one connection, exactly like `@core/scheduler`'s timer, with no per-node process boundary in the way at all. Every other node (the `@hass/action`/`@hass/read` boundary blocks, and any ordinary block — like `battery_controller` below — that calls `readEntityState()`/`performHassAction()` directly) still runs in its own persistent Worker as before, but that Worker holds no connection of its own: it relays reads and calls back to its own flow-host's single connection over a small postMessage protocol (`setHassReadTransport`/`setHassCallTransport` in `hass/client.ts`/`hass/action.ts`, answered by `worker-manager.ts`). Block code never sees this distinction — it just calls `readEntityState()`/`performHassAction()` either way — so the same code still runs unmodified whether it's executing in Phase 1's single-process demo (talking to `getHass()` directly) or inside a Phase 2 Worker (relayed). The dry-run/call logic itself still lives in exactly one place (`performHassAction()` in `hass/action.ts`), so it's never duplicated regardless of which path reaches it.

### Pluggable execution: the same Router, three different backends

`Router` doesn't call `block.process()` directly — it delegates to a swappable `NodeExecutor`. Phase 1's demo uses the default `InProcessExecutor` (today's logic, extracted verbatim). Phase 2's flow-host supplies a `DistributedExecutor` instead: ordinary nodes (including `@hass/action`/`@hass/read`) go to a persistent per-node `Worker` (spawned once per flow-host lifetime, never per-message — the concrete mitigation for a Bun-`Worker`-leak risk flagged in the Phase 0 spikes, since that risk was specifically about *rapid repeated* spawn/terminate cycles, which this design never does); `@hass/trigger` skips the Worker/Router-delivery path entirely (see above); and only `@ai/agent` goes to the coordinator over IPC, which itself relays the call onward to the dedicated `ai-host` process (see [An embedded Claude Code agent](#an-embedded-claude-code-agent-with-no-capability-beyond-what-a-human-already-has) below) — the coordinator's own `flow-host`-facing IPC contract didn't need to change just because who ultimately answers `@ai/agent` calls did. Same wiring format, same typecheck gate, same block code, several different places the actual `process()` call (or, for `@hass/trigger`, the equivalent subscription) can happen — the Router itself never needs to know which.

`@ai/openai_agent` is a deliberate drop-in for `@ai/agent` at the wiring level (same `prompt` input, same result shape, same `{prompt, meta}` correlation convention) — but architecturally the two could not be more different: it holds no Claude credentials and needs no Agent SDK session, so it never touches the coordinator or `ai-host` at all. It's a plain ordinary node, going through the exact same per-node `Worker` path as `@hass/action` — its "agent" is just a self-contained HTTP client (plus a small tool-calling loop against `readEntityState`/`performHassAction`/`listExposedEntities` directly) talking to whatever OpenAI-chat-completions-compatible server its `baseUrl` config points at (a local `llama.cpp`/Ollama/vLLM server, or a real hosted endpoint). One real constraint fell out of this: `WorkerManager` enforces a blind 10s kill-and-respawn ceiling on every ordinary node's `exec()` call, which is fine for instant blocks but would silently truncate a slower model's response (and, after three such kills in its 60s window, permanently mark the node dead) — so `DistributedExecutor` now reads a numeric `timeoutMs` off a node's own resolved config, when present, and passes it through (plus a margin) as that one node's own override, leaving every other block's blind default untouched.

### Supervision: crash recovery, and typechecking as a gate on the *running* process

The coordinator restarts a crashed flow-host with exponential backoff (500ms base, capped at 30s), and flags a flow `crash-looped` after more than 5 unexpected exits in a rolling 5-minute window rather than restarting forever. Critically, the coordinator runs the typecheck gate itself, *before* ever touching a running flow-host: a `data/blocks/*.ts` edit re-typechecks every loaded flow (since the generated wire-assertion file inherently covers all of them together), and on failure every flow's existing process is left completely alone — verified directly by comparing pids before and after a deliberately broken edit. Only a passing typecheck triggers an actual restart.

### Single-input firing, not join semantics

A block's `process()` fires once per message arriving at *one* named input port; the runtime only ever populates that one port, even if the block declares several. This is a deliberate simplification (documented loudly in `block.ts`) rather than an oversight: every block in this codebase has exactly one input, "wait for all ports to have a value" (join semantics) is a meaningfully different and more complex feature, and it's better to ship the simple version and let a block that genuinely needs cross-port memory use its own state (exactly how `debounce` remembers its last timestamp) than to build unneeded machinery speculatively.

### Concurrent across nodes, serial within one node

`Router` was single-concurrency for most of this project's life — one global FIFO queue, one delivery in flight at a time, deliberately simple and correct by construction. That stopped being good enough once a real flow could fan one message out to two genuinely slow siblings (a voice prompt going to both a Claude-backed `@ai/agent` and a local-LLM `@ai/openai_agent` node at once, to compare answers): the second sibling had to wait out the *entire* first one before even starting — measured directly on a live deployment at ~14s combined for two calls that individually take a few seconds each, no different in shape from Node-RED's own single-threaded message passing.

The fix keeps a fully separate FIFO queue and independent drain loop *per node* rather than one shared queue: different nodes' deliveries run truly concurrently — each `executor.execute()` call (a real Worker round-trip, or a real HTTP/IPC call for a relay/duplex block) genuinely in flight at the same wall-clock time as its siblings' — while a single node's own successive deliveries still execute strictly in order. That ordering guarantee isn't incidental: `ctx.state.block`/`ctx.state.flow`/`ctx.state.global` are a plain get-then-set API (see below), and plenty of real blocks do exactly a "read a key, compute, write it back" sequence spanning two separate `await`s (`voice_gate`'s own conversation-history append, among others) — re-entering the *same* node's `process()` concurrently would turn that into a lost-update race that no existing block author had to defend against. Serializing same-node deliveries preserves that guarantee for free while still delivering the parallelism that actually matters for throughput: sibling branches of a fan-out, and independent chains triggered around the same time. `waitForIdle()` (used by tests and the demo runner) re-snapshots the set of currently-active per-node drains in a loop rather than awaiting one fixed set, so it correctly waits out a grandchild delivery spawned by a slow branch *after* `waitForIdle()` was already called. Exercised directly in `packages/runtime/src/router/router.test.ts` — concurrent siblings, same-node serialization even under two independent triggers, a slow sibling not blocking a fast one, and idle-waiting across a multi-hop cascade are each their own test.

This does **not** newly protect state two *different* node types deliberately share (both doing read-modify-write on the same flow/global-scope key) — that was only ever accidentally safe before, as a side effect of the entire router being single-threaded. A flow that wants two distinct node types to coordinate through shared state now needs to make that coordination step a single atomic SQL operation itself (computing the new value directly in the write, or wrapping both the read and the write in one transaction) rather than "read in JS, compute, write in JS" — nothing currently running does this, but it's a real, newly-possible failure mode worth knowing about before designing something that would.

### Three-scope state over SQLite, not in-memory

State is explicitly *not* purely functional — it's `bun:sqlite` in WAL mode, with per-block, per-flow, and global scopes sharing one `flowbun.sqlite` file, partitioned by a `(scope, scope_key, key)` primary key. State living outside the block's own memory means it survives block reloads and flow restarts — a debounce timer, a "have I already fired today" flag, and similar bookkeeping shouldn't evaporate every time you save a file and the flow hot-reloads. Multi-process concurrent access to one SQLite file was one of the Phase 0 spikes (setting `busy_timeout` collapsed contention errors from ~99.8% of writes to ~0.01% under a deliberately adversarial worst case, with no corruption or lost writes) — and Phase 2 confirmed it directly: a `debounce` timestamp survived a real `kill -9` of its flow-host process byte-for-byte, with the coordinator and every flow-host's Workers all opening independent connections to the same `flowbun.sqlite`.

### Messages are copy-on-write via `structuredClone`

Every hop between blocks clones the payload, even in Phase 1's single-process demo, which could otherwise get away with passing references. This was deliberate ahead of time: it keeps a block's mutation of its own inputs from ever silently corrupting a sibling branch's copy of the same message, and it meant Phase 2 — where some of these hops became real Worker `postMessage`/IPC boundaries with unavoidable serialization — needed zero changes to block-author-visible behavior. Confirmed, not just planned: the same block code runs unmodified in both topologies.

### The editor has no privileged access, and writes are minimal-diff, not regenerated

The browser editor talks to the coordinator over a single websocket ([`flowbun/ws`](packages/runtime/src/ws/protocol.ts)): fire-and-forget pushes for state the server always knows more about than any one client (a `snapshot` on connect, then `flow.updated`/`flow.status`/`log` broadcasts), and `requestId`-correlated request/response for anything that mutates something (`wiring.mutate`, `block.write`, `flow.restart`). There is no separate privileged API — every mutation re-reads the target file fresh from disk, applies the change, re-typechecks, and only then restarts the affected flow, which is exactly what a human editing the file directly and re-running the coordinator would cause.

Saving a wiring edit does **not** regenerate the file from the in-memory object. An early attempt at `JSON.stringify(wiring, null, 2)` reformatted with Biome still failed to reproduce the file's existing mix of inline and expanded objects — Biome preserves whichever bracket style is already on disk, it doesn't compute one from content. Instead, [`wiring-writer.ts`](packages/coordinator/src/wiring-writer.ts) uses [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) (the same library VS Code uses to edit your `settings.json`) to patch only the specific JSON path that changed — a no-op produces byte-identical output, a config edit is a single-token replacement, a node deletion removes exactly that node's text. The one accepted limitation: adding a brand-new node or wire re-expands whichever sibling immediately precedes the insertion point (an unavoidable consequence of emitting "prev-prop + comma + new-prop" as one edit) — bounded to one adjacent sibling, never file-wide, and it doesn't affect the common drag/config-edit operations.

### Every write to `data/` is auto-committed to its own dedicated git history

`data/blocks` and `data/wiring` are tracked in a *separate* git repository (`data/.git`, initialized and auto-committed by `packages/coordinator/src/git-snapshot.ts`) — not the main flowbun repo's own history. Every write, from any source (the editor's UI, an external edit the fs-watcher picks up, or the agent below), is staged and committed via one hook (`snapshotting-serializer.ts`) that wraps the same reload path every write already goes through — nothing can add a new write path without inheriting this for free. This is what makes undo/redo durable across a coordinator restart (`undo-stack.ts` derives it from git log, not an in-memory stack that a restart used to wipe) and gives the editor's History panel arbitrary point-in-time restore, always as a new forward commit, never a destructive `git reset`. The split from the main repo's history is deliberate: this is high-frequency, machine-generated edit history, not the deliberate, curated commits a human reviews in a PR.

### An embedded Claude Code agent, with no capability beyond what a human already has

The editor's chat panel talks to a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) `query()` loop — originally run inside the coordinator process, since extracted into its own dedicated `packages/ai-host` process (`ai-host/src/agent/`), spawned by the coordinator (`coordinator/src/ai-host-client.ts`, via `Bun.spawn`, the same pattern as a flow-host child) and talked to over its own IPC contract (`flowbun/ipc`'s `CoordinatorToAiHost`/`AiHostToCoordinator`). The extraction kept the capability boundary intact, just moved which process enforces it: `ai-host` is given exactly one capability surface, an MCP server (`ai-host/agent/mcp-server.ts`) whose tools don't call anything locally — each one is relayed back over IPC to the coordinator (`ai-host-client.ts` → `coordinator/src/agent/dispatch-tool-call.ts` → `agent/tools.ts`), which calls the *same* `wiring.mutate`/`block.write`/`createFlow`/`createBlock`/etc. functions the browser's own websocket handlers call. Every built-in SDK tool (Bash, Read, Write, Edit, WebSearch, ...) is still explicitly disabled (`tools: []`). Concretely, this means an agent edit is typechecked, git-committed, and undo-tracked exactly like a human edit, through the exact same code path — not a parallel, less-audited one. It's also why this feature was built *after*, not before, `data/`'s own git history above: the agent's write access is only as safe as the ability to see and revert exactly what it changed.

The *currently active* session is single and coordinator-global, not per-browser-connection — nothing else in this app has a per-user concept (every open tab already shares one `flows` map and one log stream), so the chat transcript is shared the same way. Authentication is a long-lived OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, minted once via `claude setup-token`) passed in through `.env` rather than baked into an image or committed anywhere — see [Setting up the Claude Code agent](#setting-up-the-claude-code-agent-optional) below. `ai-host`, not the coordinator, is the process that actually holds this token and talks to the Claude Agent SDK; the coordinator never sees it. Claude's own conversation transcripts and session state still live under `data/agent/` (`CLAUDE_CONFIG_DIR`), the same bind-mounted, persists-across-rebuilds directory `data/blocks`/`data/wiring` do, but explicitly excluded from `data/`'s own git history (`data/.gitignore`), since transcripts can contain anything discussed in chat.

The chat panel can also start a new session or resume a previous one from a dropdown — sourced by reading the Claude Agent SDK's own on-disk transcripts directly (globbed from `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`, rather than reimplementing the SDK's private, version-dependent cwd-to-directory-name encoding scheme), not a flowbun-owned duplicate log. Replaying a past session's history reconstructs the user's own prompts too, not just the assistant's replies — live streaming never echoes a user's own text back as an event (the browser already renders its own optimistic bubble for what it just sent), so replay opts into a `user.text` event `translateSdkMessage` otherwise never emits. Switching sessions is global, not per-tab, consistent with the paragraph above: every connected tab sees the same conversation, kept in sync by a `chat.historyReset` broadcast the moment the current session changes.

### Optional authentication: off by default, opt-in with a username/password

Neither the coordinator's `flowbun/ws` control API nor the editor's HTTP server require a login by default — matching the rest of this project's "no privileged access, anything the editor can do a script can too" stance, and simplest for the common case of a single-household LAN nobody else can reach. Set both `FLOWBUN_AUTH_USERNAME` and `FLOWBUN_AUTH_PASSWORD` (plaintext) to turn login on; leave either unset and every existing deployment keeps working exactly as before, no code path even checks. The shared logic lives in `packages/runtime/src/auth/session.ts` (exported as `flowbun/auth`), consumed identically by the coordinator's `/ws` upgrade handler and the editor's `/api/login`/`/api/session`/`/api/logout` routes — the same one place decides what "logged in" means for both.

A session is a minimal hand-rolled JWT (HS256 only, no dependency added for it — the alg is never read back from the token itself, the standard defense against alg-confusion attacks), signed with a random key generated once on first use and persisted to `data/state/auth-secret.key` (bind-mounted, gitignored, survives container restarts — the entire point, since sessions are deliberately long-lived: 10 years, "log in once, stay in," appropriate for a single household's own devices rather than a multi-tenant service). A browser client gets the token as an httpOnly cookie from `/api/login`; the editor's React app never even attempts the websocket connection until it's confirmed one exists (`LoginGate.tsx`) — the coordinator's own `/ws` handler is the actual enforcement point regardless, not the editor's login screen, which is UX around getting a valid token, same as everything else the editor does. A script/`curl` client can skip the browser entirely and pass `Authorization: Bearer <token>` instead, obtained from the same `/api/login` endpoint.

Assistant replies render as markdown (`react-markdown` + `remark-gfm`, deliberately with no raw-HTML plugin enabled — safe by default against a reply that happens to echo back HTML-looking content, e.g. an HA entity's `friendly_name`, with no extra sanitization work needed). Each `chat.send` also carries the wiring file the sending tab currently has open in the canvas, if any; the coordinator folds that into just that turn's system prompt — never persisted as part of the conversation, since it reflects whatever the sending tab happens to be looking at right now — so the agent can resolve an ambiguous "this flow"/"it" without asking which one the user means.

### A second package-export subpath, because the browser can't import `bun:sqlite`

The editor's client bundle needs `Wiring`/`parsePortRef` types and the `flowbun/ws` protocol types, but importing anything from the main `flowbun` barrel — even a pure function — transitively pulls in `bun:sqlite` and `@digital-alchemy/hass`'s Node-only dependencies, which fail outright in a browser bundle. The fix is `flowbun/wiring`, a separate `package.json` export pointing directly at `wiring/schema.ts` (which depends on nothing but `zod`), so the editor imports `Wiring`/`parsePortRef` from there and the main runtime package stays exactly as Node/Bun-only as it needs to be.

### A package registry that's just files in a git repo, not a service

Sharing a ready-made block or flow shouldn't need a package server: [`flowbun-registry`](https://github.com/flowbun/flowbun-registry) is a plain git repo, browsed and installed from over `FLOWBUN_REGISTRY_URL` (`packages/coordinator/src/main.ts`), which accepts either an `https://` base — `raw.githubusercontent.com/flowbun/flowbun-registry/main` by default, no git client or tarball extraction needed on the installing side, just plain `fetch` — or a bare filesystem path, the same duality this repo's own `docker-compose.yml` exercises by bind-mounting a sibling checkout read-only at `/app/registry` and pointing `FLOWBUN_REGISTRY_URL` straight at it, so this exact deployment installs from an uncommitted local checkout rather than the network. Each package version is an immutable folder (`packages/<name>/<version>/`, never mutated once published — a fix ships as a new version folder) holding a `flowbun.json` manifest, `blocks/*.ts`, and optional example `wiring/*.json`; the registry's own generated `index.json` is the only file `flow-packages.ts` fetches to browse, listing every version's manifest fields plus a `sha256:` hash per file, which `fetchAndVerify()` re-checks against the actually-downloaded bytes before anything is written to disk — a hash mismatch aborts the install with zero files touched. A `flowbun` field (`">=1.2.0"`-style, parsed by the deliberately narrow `parseFlowbunRange()`) is checked against the running coordinator's own runtime version, and anything it can't parse is treated as incompatible rather than guessed at.

The registry's own build script refuses to publish any wiring file lacking a top-level `"disabled": true` — a freshly installed automation that auto-started would immediately act on the user's real Home Assistant before they'd so much as looked at it — but `flow-packages.ts` doesn't trust that upstream promise either: it forces `disabled: true` onto every wiring file's parsed JSON itself, unconditionally, before ever writing it (`const forced: Wiring = { ...parsed, disabled: true }`), so even a compromised or buggy registry response can't skip the review step. Registry paths are also re-validated against path traversal (`isSafeRegistryPath()` — no `..`, no absolute path, must start with `blocks/` or `wiring/`) independent of anything the registry's own index build already enforces, on the assumption that the fetched bytes are untrusted input regardless of where they came from.

### Installing a package writes real files down the same pipes everything else uses

`flow-packages.ts`'s `install`/`update`/`uninstall` (exposed over `flowbun/ws` as `pkg.flow.install`/`pkg.flow.update`/`pkg.flow.uninstall`, alongside `pkg.flow.registry`/`pkg.flow.list` for browsing and `pkg.npm.list`/`pkg.npm.add`/`pkg.npm.remove` for npm dependencies on their own) don't have a privileged write path of their own. Once every file for a version is fetched and sha256-verified, they land under `data/blocks/`/`data/wiring/` exactly like anything else on disk, and the same `reloadBlocksAndRestartAll`/`reloadWiringFile` functions the browser's own wiring editor and the embedded agent both call are what typecheck and restart the affected flows afterward — the install function is handed these as injected dependencies, not a reimplementation, so an installed block is typechecked and git-committed through the identical path a hand-written one goes through (see "Every write to `data/` is auto-committed to its own dedicated git history" above), and `block-loader.ts`'s discovery scan can't tell the two apart once they're on disk. `data/flowbun-packages.json`, the tracking file recording each installed package's name/version/file hashes, rides the same `data/.git` auto-commit for the same reason — it's just another file under `data/`.

A package's declared `npmDependencies` are resolved by actually shelling out to `bun add <dep>@<range>` (`npm-packages.ts`'s `installNpmPackage`) inside `data/` itself — a real, independent npm project (`data/package.json`, `data/bun.lock`) deliberately excluded from the root workspace's `workspaces: ["packages/*"]`, so a block's third-party imports resolve at both runtime and in the typecheck gate without ever touching the tool's own dependency tree. That leaves a genuine `data/node_modules`, which `data/.gitignore` excludes from the data-dir's own git history exactly like the outer repo's root `.gitignore` excludes its own `node_modules/` — while `data/package.json`/`data/bun.lock` themselves are tracked by `data/.git`, not this repo's (its own `.gitignore` explicitly excludes those two paths plus the tracking file, since a live instance's package installs aren't this repo's commit history to own). `selfHealNpmInstall()` reruns `bun install` in `data/` on every coordinator boot — a no-op if `data/package.json` doesn't exist yet — to resync `node_modules` in case a container came up without it, failing open exactly like `git-snapshot.ts`'s own `ensureRepo()` does. Installing isn't "latest only," either: `install()` defaults to the newest version (the registry's own index lists each package's versions newest-first) but takes an explicit one, and `update()` can move to any version the registry still has — including back down — refusing to touch a package whose installed files no longer match their tracked hash (a local hand-edit since install) unless `force` is passed.

## Running it

```sh
bun install
cp spikes/s3-da-hass/.env .env   # or your own HASS_BASE_URL / HASS_TOKEN
bun run demo:hallway
```

This discovers the blocks in `data/blocks/`, validates and typechecks every flow in `data/wiring/`, then looks for two specific example flows by name to run in-process: `outdoor_temp_demo` (a real, Zod-validated fetch to a public weather API) and `hallway_lights` (a real, read-only subscription to a Home Assistant motion sensor, feeding `debounce → presence_logic → @hass/action`, with the final light command logged in dry-run rather than executed). **Both have since been superseded by real automations** (see below) and no longer exist in `data/wiring/` — the lookup is guarded, so `demo:hallway` still runs and typechecks cleanly, it just has nothing left to actually demo. It's kept for what it still proves about the headless in-process topology from Phase 1, not as the primary way to see the system running; `bun run coordinator` (next) is that. Set `FLOWBUN_DEMO_WINDOW_MS` to change how long it listens (default 2 minutes; `0` runs until Ctrl-C), and `FLOWBUN_DRY_RUN=false` if you're ready to let it make real service calls.

For the real distributed topology instead of the single-process demo:

```sh
bun run coordinator
```

This runs the typecheck gate once up front, then spawns one flow-host child process per file in `data/wiring/` — currently: `battery_controller` (a real, live grid-zero export controller translated from an existing Home Assistant YAML automation, kept as a comment at the bottom of `data/blocks/battery_controller.ts` for comparison), `blinds_sun_tracker` (a real, live automation closing an east-facing window's blinds before sunrise on forecast-hot days and progressively reopening them as the sun's azimuth sweeps past the window — tracking `sun.sun` via `@core/scheduler` + `@hass/read` rather than a single coarse `@hass/trigger`), and `voice_assist_demo` (a real, live conversation-agent backend for a Home Assistant Assist voice pipeline — `@http/in` receives a transcribed utterance from the `flowbun_conversation` HA integration, `@ai/agent`/`@ai/openai_agent` decide what to say and do against the household's actually-exposed entities, and the reply is spoken back through the same satellite). Each flow-host spawns its own Worker per ordinary block (`@hass/trigger` is the one exception — see "Effects live strictly at the boundary" above). Saving a file under `data/blocks/` or `data/wiring/` triggers a debounced reload; `kill -9`-ing a flow-host's pid demonstrates the crash-recovery path. `Ctrl-C` (or a plain `kill`/`pkill`) shuts everything down cleanly, including every child. The coordinator also opens a websocket control API on port `8787` (`FLOWBUN_WS_PORT`) as soon as it's up.

For the browser editor, alongside the coordinator:

```sh
bun run editor
```

Open `http://localhost:4200`. The editor is a static/dev server plus one `/config.json` endpoint that tells the browser which coordinator websocket to connect to — it derives that address from whatever host/IP the browser used to reach the page itself (not a hardcoded `localhost`), so the same build works whether you're on the machine running it or reaching it over the LAN (see [Docker](#docker), below). Set `FLOWBUN_COORDINATOR_WS` to override this explicitly.

See [`spikes/DECISIONS.md`](spikes/DECISIONS.md) for the Phase 0 evidence behind these choices, and the `RESULTS.md` in each `spikes/sN-*/` directory for the full detail behind each one.

## Docker

A `Dockerfile` bundles the coordinator and editor into one image (`docker-entrypoint.ts` runs them as sibling processes; either one dying kills the container, so a restart policy can recover it rather than it running half-broken). Build with either engine:

```sh
docker build -t flowbun:demo .
# or: podman build -t flowbun:demo .
```

Run it with `data/` bind-mounted (so wiring/blocks stay editable and persist across container restarts — nothing under `data/` is baked into the image) and your real `HASS_BASE_URL`/`HASS_TOKEN` passed at run time, never built into a layer:

```sh
docker run -d --name flowbun-demo \
  -p 4200:4200 -p 8787:8787 \
  -v "$(pwd)/data:/app/data" \
  --env-file .env \
  flowbun:demo
```

Then open `http://<host>:4200` — including from another machine on the LAN, since the `/config.json` host-derivation described above means the published port just works without extra configuration. `FLOWBUN_DRY_RUN=true` is the image's baked-in default, so a container started with no other configuration can never make a real Home Assistant write.

Both `4200` (editor) and `8787` (the coordinator's `flowbun/ws` control API — arbitrary block/wiring writes, not just reads) are published to whatever the container's `-p`/`docker-compose.yml` mapping exposes them to, with no login required by default (see "Optional authentication" above). If that container is reachable beyond your own LAN — a port-forward, a more permissive network — set `FLOWBUN_AUTH_USERNAME`/`FLOWBUN_AUTH_PASSWORD` in `.env` before exposing it any further.

Equivalently, the repo's own `docker-compose.yml` already wires up the same ports/bind-mount/`.env` — `docker compose up -d --build` builds and runs it in one step, and is the path this repo's own deployment actually uses. A `docker-compose.yml`-launched container is still just named `flowbun-demo` with the same image tag, so every other command in this README (`docker exec flowbun-demo ...`, the Claude Code auth script below) works the same regardless of which of the two you used to start it.

## Setting up the Claude Code agent (optional)

The editor's chat panel (see [above](#an-embedded-claude-code-agent-with-no-capability-beyond-what-a-human-already-has)) needs a one-time interactive login before it can talk to Claude — this can't be scripted end-to-end since it's a real browser OAuth flow, but `scripts/setup-claude-auth.sh` gets you there and confirms it worked:

```sh
./scripts/setup-claude-auth.sh
```

This starts the `flowbun` container if it isn't already running, then runs `claude setup-token` inside it — follow the printed URL to log in with your Claude subscription (Pro/Max/Team/Enterprise). It ends by printing a long-lived OAuth token; copy it into `.env` as:

```
CLAUDE_CODE_OAUTH_TOKEN=<the token you copied>
```

then `docker compose up -d` to restart the container so it picks up the new variable (`docker-compose.yml` already loads `.env` via `env_file`). `.env` is git-ignored at the repo root, so the token is never committed — and it's not the `data/` git history either, since that only ever tracks `data/blocks`/`data/wiring`. You only do this once per `.env`, not per deploy.

Without this step, the chat panel still works but responds with a clear "not authenticated yet" message instead of a reply — it never hangs or crashes waiting for credentials that don't exist.

## Development

Lint/format is [Biome](https://biomejs.dev/); `bun run lint` / `bun run format` run it directly. A [husky](https://typicode.github.io/husky/) pre-commit hook (`.husky/pre-commit`) runs the lint check and blocks the commit on failure — it's wired up automatically by `bun install` (via the root package's `prepare` script), no manual setup needed after cloning.
