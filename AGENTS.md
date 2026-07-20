# AGENTS.md

Operational quick-reference for coding agents working in this repo. For the
full architecture rationale (why each decision was made), read
[`README.md`](README.md) first — this file assumes it and only covers what
you need to *act* correctly day to day.

## What this is

Flowbun is a flow-based home automation runtime: a `packages/coordinator`
process supervises one `packages/flow-host` child process per flow (each
owning that flow's one real Home Assistant connection), which in turn runs
each node as a persistent Worker built from `packages/runtime` (the
`flowbun` package). `data/blocks/*.ts` and `data/wiring/*.json` are the
actual automations — plain TypeScript blocks and JSON wiring, not baked
into the Docker image.

## This controls real hardware — read before touching `data/`

- `data/blocks/` and `data/wiring/` are a **live production deployment**,
  not just source code. The blocks currently running there control real
  batteries and other real Home Assistant entities in someone's house.
- `@hass/action` (and any block that calls `performHassAction()` directly,
  e.g. `battery_controller`) respects `FLOWBUN_DRY_RUN`, default `"true"`
  (safe). **The actual running deployment's `docker-compose.yml` sets
  `FLOWBUN_DRY_RUN=false`** — i.e. it is live, not dry-run. Treat every edit
  to `data/blocks/`/`data/wiring/` as something that will immediately issue
  real service calls once reloaded, not a no-op you can casually try.
- Never print, `cat`, or otherwise surface `.env` — it holds a long-lived
  `HASS_TOKEN`, and possibly `FLOWBUN_AUTH_PASSWORD` (see below). If you need
  to check a variable's value, `grep` for the key name and redact the value,
  or better, check `docker exec <container> printenv <VAR>` for a single
  non-secret variable instead of dumping the whole file.
- The coordinator's `flowbun/ws` control API (port `8787`) can write and
  execute arbitrary `data/blocks/*.ts`, run arbitrary SQL against the state
  DB, and rewrite any flow's wiring — it has no login by default. Set
  `FLOWBUN_AUTH_USERNAME`/`FLOWBUN_AUTH_PASSWORD` to require one (see
  README's "Optional authentication" section, and `flowbun/auth`) before
  that port is reachable from anywhere you wouldn't trust with shell access
  to this host.

## `data/` hot-reloads — do not rebuild Docker for a `data/`-only change

`data/` is bind-mounted into the running container (see `docker-compose.yml`),
never baked into the image. The coordinator runs its own debounced
`fs.watch` pipeline (`packages/coordinator/src/watcher.ts`) that typechecks
every edit under `data/blocks/`/`data/wiring/` and hot-restarts only the
affected flow(s) — automatically, within seconds, with no image rebuild.

- Edited only `data/blocks/*.ts` or `data/wiring/*.json`? **Don't run
  `docker compose build`/`up -d`.** Confirm the reload instead:
  `docker compose logs --since 5m | grep -i "reload\|typecheck OK\|status"`.
  A failed typecheck leaves the *old* flow process running untouched and
  logs the error — nothing partially starts.
- Edited anything under `packages/` (runtime, coordinator, flow-host,
  editor, ai-host)? That *is* baked into the image — this needs
  `docker compose build && docker compose up -d`.
- `data/blocks` and `data/wiring` are tracked in their own separate git repo
  (`data/.git`), auto-committed on every write by
  `packages/coordinator/src/git-snapshot.ts`. This is independent of the
  main repo's own git history (the one `git status`/`git log` at the repo
  root shows) — don't confuse the two, and don't try to `git add`/commit
  `data/` changes through the main repo.

## Commands

```sh
bun install              # install deps (also wires up the husky pre-commit lint hook)
bun run lint              # biome check — CI gate, also runs on pre-commit
bun run format             # biome format --write
bun run typecheck            # tsc --noEmit across every packages/* workspace — CI gate
bun test                      # full test suite — CI gate
bun run coordinator              # run the real distributed topology (needs .env / HASS_*)
bun run editor                    # editor dev server, alongside coordinator
bun run demo:hallway                 # Phase 1 in-process demo — see below
```

**`bun run typecheck` does not cover `data/blocks/`.** Those are typechecked
by a separate mechanism: a synthetic wire-assertion file generated fresh
from every block+wiring in `data/`, run via `tsc --noEmit --incremental`
(`packages/runtime/src/typecheck/run.ts`). The coordinator runs this
automatically on every reload; to check it manually without touching the
live deployment, run `bun run demo:hallway` — it discovers `data/blocks/`,
loads every flow in `data/wiring/`, and runs the same typecheck gate before
doing anything else (`[demo] typecheck OK` on success). Do this after
editing anything in `data/blocks/`, before assuming a change is even
syntactically valid.

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, and `test` as
three separate jobs — matches the commands above exactly.

## Testing notes

- `bun test` currently has 7 pre-existing failures in
  `data/blocks/__tests__/blind_sun_tracker.test.ts`, unrelated to typical
  work elsewhere in the repo. Don't be alarmed by them and don't attempt to
  fix them incidentally while working on something else — confirm with
  `git diff --stat` that you haven't touched `blind_sun_tracker.ts`/its test
  before treating a failure there as pre-existing vs. something you caused.
- After any change touching `packages/runtime`, `packages/flow-host`, or
  `packages/coordinator`, run `bun test` for the affected package(s) at
  minimum; a full `bun test` run across the monorepo takes well under 10s.

## Code conventions

- This codebase is heavily AI-written and leans into **very thorough,
  consistent "why"-focused doc comments** — not what the code does, but the
  non-obvious reasoning, constraints, or incident history behind it. Match
  this style when editing existing files; don't strip existing rationale
  comments, and don't add comments that just restate the code.
- Blocks (`data/blocks/*.ts`) are plain typed async functions via
  `defineBlock` — no bespoke control-flow DSL. Effects that reach Home
  Assistant are confined to `@hass/trigger`/`@hass/action`/`@hass/read`,
  plus any block that explicitly imports `readEntityState`/
  `performHassAction` from `flowbun/hass/client`/`flowbun/hass/action`
  directly (a documented, deliberate exception — see `battery_controller.ts`'s
  own doc comment for why).
- Wiring edits from code (not the editor) should still go through minimal,
  targeted changes — the wiring JSON files are meant to stay human-diffable
  and git-friendly; avoid wholesale reformatting/regenerating a wiring file.
- Don't add error handling/fallbacks for scenarios the typecheck gate or
  Zod boundary validation already rules out — see README's "Two-tier trust"
  section for where compile-time vs. runtime validation applies.

## Architecture cheat sheet

- **Coordinator**: light-touch. Never holds a Home Assistant connection, and
  never talks to the Claude Agent SDK directly either. Supervises flow-host
  *and* `ai-host` child processes (spawn/restart/backoff/crash-loop),
  watches `data/` for reloadable edits, typechecks, serves the `flowbun/ws`
  control API, and implements the tool handlers the embedded chat agent
  calls back into over IPC.
- **Flow-host**: one process per flow, owns that flow's *one* real HA
  connection (opened lazily). `@hass/trigger` nodes are subscribed directly
  in the flow-host's main thread (no Worker); every other node gets its own
  persistent Worker. A Worker has no HA connection of its own — it relays
  reads/calls back to its flow-host's connection over a small postMessage
  protocol (`setHassReadTransport`/`setHassCallTransport` in
  `hass/client.ts`/`hass/action.ts`, answered by `worker-manager.ts`).
- **ai-host**: a separate process (`packages/ai-host`), spawned by the
  coordinator, holding the actual Claude Agent SDK `query()` loop, MCP
  server, session transcripts, and OAuth credentials — the coordinator only
  relays tool calls to/from it over IPC (`ai-host-client.ts`).
- **Router**: single-concurrency drain per flow (`packages/runtime/src/router/router.ts`)
  — one node executes at a time within a flow; a burst of trigger events
  queues rather than running concurrently.
- **Auth** (`flowbun/auth`, `packages/runtime/src/auth/session.ts`): opt-in
  username/password + long-lived JWT session, shared by the coordinator's
  `/ws` upgrade and the editor's `/api/login`/`/api/session`. A no-op unless
  `FLOWBUN_AUTH_USERNAME`/`FLOWBUN_AUTH_PASSWORD` are both set.
- Full detail and the reasoning behind each of these: README.md's
  "Architecture decisions, and why" section.
