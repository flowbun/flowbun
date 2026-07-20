import { unlink } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { LoadedFlow, Wiring } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  runTypecheck,
  WiringSchema,
} from "flowbun";
import type {
  FlowEntry,
  FlowStatus,
  ServerToClient,
  TypecheckOutcome,
} from "flowbun/ws";
import type { AgentToolDeps } from "./agent/tools";
import { createAiHostClient } from "./ai-host-client";
import { ChatEventBuffer } from "./chat-event-buffer";
import { runReplQuery } from "./db-repl";
import { formatWithBiome } from "./format-block";
import { createGitSnapshotter } from "./git-snapshot";
import { LogBuffer } from "./log-buffer";
import { createReloadSerializer } from "./serialize-reload";
import { createSnapshottingSerializer } from "./snapshotting-serializer";
import { Supervisor } from "./supervisor";
import { collectSystemStats } from "./system-stats";
import { UndoStack } from "./undo-stack";
import { startWatcher } from "./watcher";
import { buildPalette, startWsServer } from "./ws-server";

const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");
const WS_PORT = Number(Bun.env.FLOWBUN_WS_PORT ?? 8787);
// A full reload (typecheck + restart) routinely takes longer than a
// single-digit hundred ms, so a burst of edits within that window can
// trigger several overlapping reloads for the same file. 2s comfortably
// covers one reload cycle without meaningfully delaying a genuinely new
// external edit that happens to land right after.
const SELF_WRITE_SUPPRESS_MS = 2000;

interface FileFlow {
  file: string;
  wiring: Wiring;
  flow: LoadedFlow;
}

interface FailedFlow {
  file: string;
  /** Present unless the JSON itself didn't even parse -- see loadAllFlows. */
  wiring?: Wiring;
  error: string;
}

/**
 * Derives a filesystem-safe identifier from whatever the user typed in the
 * "New flow"/"New block" dialogs — lowercase, non-alphanumeric runs
 * collapsed to a single underscore — matching every committed wiring/block
 * file's existing name-equals-filename-stem convention (hallway_lights,
 * outdoor_temp_demo, debounce, domain_toggle, ...).
 */
function slugifyName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * A minimal but genuinely wireable pass-through block — not just empty
 * braces — so a freshly created block can be dropped onto a canvas and
 * connected immediately, then customized from something real rather than
 * from nothing.
 */
function blockSkeleton(name: string): string {
  return `import { defineBlock } from "flowbun";

export default defineBlock({
  name: "${name}",
  config: {},
  inputs: {
    input: {} as { value: unknown },
  },
  outputs: {
    output: {} as { value: unknown },
  },
  async process({ input }, ctx) {
    return { output: { value: input.value } };
  },
});
`;
}

async function loadAllFlows(
  registry: Awaited<ReturnType<typeof discoverBlocks>>,
): Promise<{ loaded: FileFlow[]; failed: FailedFlow[] }> {
  const wiringDir = join(DATA_DIR, "wiring");
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.json").scan({ cwd: wiringDir }))
    files.push(join(wiringDir, f));

  const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
  const loaded: FileFlow[] = [];
  const failed: FailedFlow[] = [];
  for (const file of files) {
    // wiring is captured outside the try so a structural assembleFlow()
    // rejection (unlike a bad-JSON loadWiringFile rejection) still leaves
    // it available below to register the flow with -- see main()'s use of
    // FailedFlow.wiring, and Supervisor.registerInactive()'s own doc comment
    // for why a broken flow still needs a status the editor can show.
    let wiring: Wiring | undefined;
    try {
      wiring = await loadWiringFile(file);
      loaded.push({ file, wiring, flow: assembleFlow(wiring, registry, db) });
    } catch (err) {
      // One flow's broken wiring (e.g. a wire pointing at a port its block
      // no longer exposes) must not take down every other flow, or the
      // whole coordinator process -- this used to be a bare, uncaught
      // assembleFlow() call inside the loop, so any single bad wiring file
      // crashed main() entirely before anything else got a chance to start.
      failed.push({ file, wiring, error: String(err) });
    }
  }
  db.close(); // transient — only needed to build LoadedFlow shapes for the typecheck gate
  return { loaded, failed };
}

/**
 * Typechecks every given flow together (the fast path: one tsc
 * invocation). If that fails, isolates which flow(s) are actually broken
 * by re-checking each one alone, so one flow's type error can't drag every
 * other, unrelated flow down with it -- the same per-flow independence
 * loadAllFlows() already gives structural (assembleFlow) errors. Shared by
 * both startup and reloadBlocksAndRestartAll() below: the two places a
 * single tsc run spans multiple flows that have nothing to do with each
 * other, so a failure in one must not read as a failure in the rest (see
 * the incident this was extracted for: a broken battery_controller wiring
 * was marking the totally unrelated blinds_sun_tracker as failed too, and
 * leaving it stuck failed even after battery_controller was fixed via a
 * narrower reload that never re-checked it).
 */
async function typecheckIsolated(
  loaded: FileFlow[],
): Promise<{ ok: FileFlow[]; failed: Array<FileFlow & { output: string }> }> {
  if (loaded.length === 0) return { ok: [], failed: [] };
  const combined = await runTypecheck(
    loaded.map((f) => f.flow),
    DATA_DIR,
  );
  if (combined.ok) return { ok: loaded, failed: [] };
  const ok: FileFlow[] = [];
  const failed: Array<FileFlow & { output: string }> = [];
  for (const f of loaded) {
    const single = await runTypecheck([f.flow], DATA_DIR);
    if (single.ok) ok.push(f);
    else failed.push({ ...f, output: single.output });
  }
  return { ok, failed };
}

async function main(): Promise<void> {
  const logBuffer = new LogBuffer();
  const chatEvents = new ChatEventBuffer();
  const flows = new Map<string, FlowEntry>();
  const gitSnapshotter = createGitSnapshotter(DATA_DIR);
  const undoStack = new UndoStack(gitSnapshotter);
  let broadcast: ((msg: ServerToClient) => void) | null = null;
  const recentSelfWrites = new Map<string, number>(); // absolute wiring/block file path -> Date.now()

  // Built before `registry` (and `supervisor`) are even assigned below —
  // every function this closes over (reloadWiringFile, createFlow, ...) is
  // a hoisted `async function` declaration, safe to reference before its
  // own textual definition, and getPalette's/listHassEntities' closures
  // over `registry`/`supervisor` only need those bindings to exist by the
  // time they're *called*, not now (the same trick `broadcast` above
  // already relies on). Needed this early because aiHostClient (below) must
  // exist before Supervisor's own construction — AgentToolDeps deliberately
  // excludes `supervisor` itself as a field (see its own doc comment on the
  // interface), so there's no real circularity here, just this ordering.
  const agentToolDeps: AgentToolDeps = {
    dataDir: DATA_DIR,
    repoRoot: join(DATA_DIR, ".."),
    flows,
    undoStack,
    getPalette: () => buildPalette(DATA_DIR, registry),
    reloadWiringFile,
    reloadBlocksAndRestartAll,
    createFlow,
    createBlock,
    deleteBlock,
    deleteFlow,
    // This coordinator holds no HA connection of its own anymore (see
    // hass/client.ts) — relayed to whichever flow-host is running instead.
    listHassEntities: () => supervisor.queryHassEntities(),
    markSelfWrite: (path: string) => recentSelfWrites.set(path, Date.now()),
  };

  // Spawns the one, app-global ai-host subprocess and owns every Claude
  // Agent SDK interaction from here on — this coordinator process itself
  // never touches Claude credentials/sessions directly (see
  // ai-host-client.ts's own doc comment).
  const aiHostClient = createAiHostClient({
    dataDir: DATA_DIR,
    deps: agentToolDeps,
    chatEvents,
  });

  // A dedicated, long-lived connection for the log panel's "DB" tab —
  // separate from the transient ones loadAllFlows() opens/closes just to
  // build LoadedFlow shapes. Safe to hold open for the coordinator's whole
  // lifetime: flow-hosts and their block workers already each keep their
  // own long-lived connection to this exact file for as long as they run
  // (see flow-host/src/main.ts and worker-entry.ts), all relying on the
  // same WAL mode + busy_timeout openStateDb already sets up. safeIntegers
  // is on here specifically (unlike every other openStateDb call in this
  // codebase) so a REPL query against a huge integer round-trips exactly
  // rather than silently losing precision — see db-repl.ts's own comment.
  const replDb = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"), {
    safeIntegers: true,
  });

  const supervisor = new Supervisor(
    DATA_DIR,
    logBuffer,
    aiHostClient,
    (flow, status) => {
      for (const entry of flows.values()) {
        if (entry.wiring.name === flow) entry.status = status;
      }
      broadcast?.({ type: "flow.status", flow, status });
    },
  );

  let registry = await discoverBlocks(DATA_DIR);
  const { loaded, failed: failedToLoad } = await loadAllFlows(registry);
  for (const { file, error } of failedToLoad) {
    console.error(
      `[coordinator] ${basename(file)}: failed to load, skipping:\n${error}`,
    );
  }

  const { ok: startable, failed: failedTypecheck } =
    await typecheckIsolated(loaded);
  if (failedTypecheck.length > 0) {
    console.error(
      `[coordinator] initial typecheck FAILED for ${failedTypecheck.length} flow(s), isolated per-flow:\n${failedTypecheck
        .map(({ file, output }) => `${basename(file)}:\n${output}`)
        .join("\n\n")}`,
    );
  }
  console.log(
    `[coordinator] initial typecheck OK for ${startable.length}/${loaded.length + failedToLoad.length} flow(s)`,
  );
  for (const { file, wiring, flow } of startable) {
    await applyRunState(file, wiring, flow, { restart: false });
    const rel = basename(file);
    flows.set(rel, {
      file: rel,
      wiring,
      status: supervisor.getStatus(flow.name) ?? { kind: "starting" },
      undo: undoStack.status(join("wiring", rel)),
    });
  }
  // None of these ever ran (registerInactive doesn't spawn), but they
  // still need a Supervisor entry — restartFlow() later (once the user
  // fixes the wiring and saves) looks flows up by name and silently no-ops
  // if the supervisor never heard of them, same as stopFlow() — and a
  // flows.set() entry so the editor can actually show and let the user fix
  // the broken file instead of it just vanishing from the UI.
  const startedAt = Date.now();
  for (const { file, wiring, error } of failedToLoad) {
    const rel = basename(file);
    const flowName = wiring?.name ?? rel;
    const status: FlowStatus = {
      kind: "failed-load",
      at: startedAt,
      output: error,
    };
    supervisor.registerInactive(file, flowName, status);
    if (wiring) {
      flows.set(rel, {
        file: rel,
        wiring,
        status,
        undo: undoStack.status(join("wiring", rel)),
      });
    }
  }
  for (const { file, wiring, flow, output } of failedTypecheck) {
    const rel = basename(file);
    const status: FlowStatus = {
      kind: "failed-typecheck",
      at: startedAt,
      output,
      stillRunning: false,
    };
    supervisor.registerInactive(file, flow.name, status);
    flows.set(rel, {
      file: rel,
      wiring,
      status,
      undo: undoStack.status(join("wiring", rel)),
    });
  }

  // Restores a flow's wiring file AND every file-backed block it
  // references, all from the same historical git-snapshot commit, as one
  // atomic operation — restoring a wiring file alone (the old behavior)
  // pairs whatever it says with *today's* block content instead of the
  // block content it actually ran against at that point in time, which is
  // exactly what broke battery_controller (see the incident this was added
  // for: a wiring restore to a pre-refactor snapshot left it wired to
  // output ports the current block no longer exposed, and nothing caught
  // it before writing). Built-in blocks (@hass/*, @core/*) ship with the
  // runtime, never live under data/blocks/, and can't drift out of sync
  // with a wiring snapshot the way a file-backed block can — only the
  // latter need restoring alongside.
  //
  // If the reconstructed set doesn't actually work — a needed block didn't
  // exist yet at that snapshot, or the combination still fails typecheck —
  // every touched file is rolled back to its exact prior content and the
  // flow reloaded again from that, so a failed restore attempt can never
  // leave a previously-working flow worse off than before the click. (This
  // still snapshots the doomed intermediate write and the rollback as two
  // separate commits, same as any other write that fails typecheck — see
  // createSnapshottingSerializer's own "success or failure" doc comment —
  // so the attempt itself stays visible in history rather than vanishing.)
  async function restoreFlow(
    file: string,
    hash: string,
  ): Promise<
    { ok: true; typecheck: TypecheckOutcome } | { ok: false; error: string }
  > {
    const relWiring = join("wiring", file);
    const wiringContent = await gitSnapshotter.readFileAt(hash, relWiring);
    if (wiringContent === undefined) {
      return {
        ok: false,
        error: `"${file}" had no content at ${hash.slice(0, 7)}`,
      };
    }
    let wiring: Wiring;
    try {
      wiring = WiringSchema.parse(JSON.parse(wiringContent));
    } catch (err) {
      return {
        ok: false,
        error: `invalid wiring at ${hash.slice(0, 7)}: ${err}`,
      };
    }

    const neededBlockNames = new Set(
      Object.values(wiring.nodes)
        .map((n) => n.block)
        .filter((b) => !b.startsWith("@")),
    );

    const wiringPath = join(DATA_DIR, "wiring", file);
    const restoredBlocks = new Map<string, string>(); // absolute block path -> content at `hash`
    for (const blockName of neededBlockNames) {
      const currentEntry = registry.get(blockName);
      // Every block in this project is `<name>.ts` under data/blocks/ (see
      // discoverBlocks) — fall back to that convention if the block isn't
      // even in the *current* registry (renamed/deleted since) rather than
      // giving up immediately; readFileAt below is the real check.
      const filename =
        currentEntry && currentEntry.origin === "user"
          ? relative(join(DATA_DIR, "blocks"), currentEntry.modulePath)
          : `${blockName}.ts`;
      const relBlock = join("blocks", filename);
      const content = await gitSnapshotter.readFileAt(hash, relBlock);
      if (content === undefined) {
        return {
          ok: false,
          error: `restoring "${file}" to ${hash.slice(0, 7)} needs block "${blockName}" (${relBlock}), which didn't exist at that point — can't reconstruct a working flow`,
        };
      }
      restoredBlocks.set(join(DATA_DIR, "blocks", filename), content);
    }

    // Snapshot "before" content for every file about to be touched, only
    // now that every needed block actually resolved above — no point
    // recording rollback state for a restore we're not going to attempt.
    const touchedPaths = [wiringPath, ...restoredBlocks.keys()];
    const before = new Map<string, string | undefined>();
    for (const path of touchedPaths) {
      before.set(
        path,
        (await Bun.file(path).exists())
          ? await Bun.file(path).text()
          : undefined,
      );
    }

    for (const [path, content] of restoredBlocks) {
      await Bun.write(path, content);
      recentSelfWrites.set(path, Date.now());
    }
    await Bun.write(wiringPath, wiringContent);
    recentSelfWrites.set(wiringPath, Date.now());

    async function rollback(): Promise<void> {
      for (const [path, prior] of before) {
        if (prior === undefined) continue; // every touched path already existed pre-restore; nothing to remove
        await Bun.write(path, prior);
        recentSelfWrites.set(path, Date.now());
      }
      registry = await discoverBlocks(DATA_DIR);
      await reloadWiringFile(
        wiringPath,
        `rollback: failed restore of "${file}"`,
      );
    }

    registry = await discoverBlocks(DATA_DIR);
    const label = `restore flow "${wiring.name}" to ${hash.slice(0, 7)}`;
    // reloadWiringFile is expected to always resolve to a TypecheckOutcome
    // rather than throw (see reloadWiringFileInner's own doc comment on the
    // structural-error catch it now has) — this try/catch is a deliberate
    // second layer, not reliance on it: the entire point of restoreFlow is
    // "never leaves a working flow worse off," so an unexpected throw here
    // still has to trigger the same rollback rather than escape uncaught
    // and crash the coordinator, exactly like it did the first time this
    // was tested (see the incident this comment was added for).
    let typecheck: TypecheckOutcome;
    try {
      typecheck = await reloadWiringFile(wiringPath, label);
    } catch (err) {
      await rollback();
      return {
        ok: false,
        error: `restoring "${file}" to ${hash.slice(0, 7)} together with its blocks threw unexpectedly, rolled back:\n${err}`,
      };
    }
    if (!typecheck.ok) {
      await rollback();
      return {
        ok: false,
        error: `restoring "${file}" to ${hash.slice(0, 7)} together with its blocks still doesn't typecheck, rolled back:\n${typecheck.output}`,
      };
    }
    await undoStack.recordEdit(relWiring);
    return { ok: true, typecheck };
  }

  /**
   * Applies a wiring file's own `disabled` flag to whether its flow-host
   * subprocess actually runs — the one check every place that starts or
   * restarts a flow (initial boot, a wiring reload, a blocks-wide reload)
   * needs to make identically, so a disabled flow can never end up with a
   * bun process regardless of which path re-evaluates it.
   *
   * Disabled: stops any running subprocess and registers a `{kind:
   * "disabled"}` status with none — idempotent (a no-op stopFlow) if it
   * wasn't running to begin with (already disabled, or never started).
   *
   * Enabled (the default): starts a fresh subprocess if none is registered
   * yet, or the flow was previously disabled (stopFlow above deregisters it
   * entirely, so re-enabling always looks like "never started" to
   * supervisor.getStatus). Otherwise leaves an already-running/restarting/
   * degraded one alone, UNLESS the caller passed `restart: true` — a
   * genuine wiring/block content change needs a fresh process to pick it
   * up; startup and a brand-new flow never do, since there's nothing
   * running yet to restart.
   */
  async function applyRunState(
    file: string,
    wiring: Wiring,
    flow: LoadedFlow,
    opts: { restart: boolean },
  ): Promise<void> {
    if (wiring.disabled) {
      await supervisor.stopFlow(flow.name);
      supervisor.registerInactive(file, flow.name, { kind: "disabled" });
      return;
    }
    const current = supervisor.getStatus(flow.name);
    if (current === undefined || current.kind === "disabled") {
      await supervisor.startFlow(file, flow.name);
    } else if (opts.restart) {
      await supervisor.restartFlow(flow.name);
    }
  }

  // Serializes EVERY reload/create operation — wiring-file reloads, the
  // blocks-wide reload, and flow creation — into one total order, not just
  // wiring reloads against each other (the original version of this only
  // chained per-file, via a Map<file, Promise>). That was too narrow:
  // reloadBlocksAndRestartAll() reassigns the shared `registry` variable,
  // and reloadWiringFileInner()/createFlow() both read it via
  // assembleFlow() — with no ordering between "a blocks reload" and "a
  // wiring reload", a wiring reload triggered moments after a new block's
  // file was created could run BEFORE that block's own reload finished
  // registering it, throwing "references unknown block" even though both
  // files were already correctly saved on disk. Found by actually hitting
  // it: creating a new block and immediately wiring a node to reference it
  // (exactly what the editor's "+ Block" -> drag-onto-canvas flow does, or
  // a script doing the same) landed within the same ~300ms debounce
  // window. A single global chain — rather than a proper readers/writer
  // lock that would let independent wiring files reload concurrently — is
  // the deliberate simple choice: reload operations here are bursty and
  // human-paced, not a throughput-sensitive path. See serialize-reload.ts
  // for the mechanism itself and its unit tests.
  const serializeReload = createSnapshottingSerializer(
    createReloadSerializer(),
    gitSnapshotter,
  );

  async function reloadWiringFile(
    path: string,
    label?: string,
  ): Promise<TypecheckOutcome> {
    return serializeReload(() => reloadWiringFileInner(path), label);
  }

  async function reloadWiringFileInner(
    path: string,
  ): Promise<TypecheckOutcome> {
    recentSelfWrites.set(path, Date.now());
    const rel = basename(path);
    let wiring: Wiring | undefined;
    let flow: LoadedFlow;
    try {
      wiring = await loadWiringFile(path);
      const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
      try {
        flow = assembleFlow(wiring, registry, db);
      } finally {
        db.close();
      }
    } catch (err) {
      // A structural error (bad JSON, or a wire referencing a node/port
      // that doesn't exist) used to propagate straight out of this
      // function uncaught -- every caller here (wiring.mutate,
      // history.restore/restoreFlow, the fs-watcher's external-edit path)
      // assumed a TypecheckOutcome {ok:false} was the only failure shape a
      // reload could produce, so this crashed the entire coordinator
      // process on its way up. Same bug loadAllFlows() used to have at
      // startup (see its own doc comment) -- missed here the first time
      // around because it only surfaces once something *live* breaks, not
      // the initial load.
      const output = String(err);
      console.error(
        `[coordinator] ${rel}: failed to load, flow untouched:\n${output}`,
      );
      const existing = flows.get(rel);
      const flowName = wiring?.name ?? existing?.wiring.name ?? rel;
      // Reflects the newly-saved (but broken) wiring content when it at
      // least parsed, same "the user's save IS what they see, plus a
      // status badge" philosophy the typecheck-failure branch below
      // already follows -- otherwise the editor keeps showing stale
      // pre-edit content while disk has something else entirely.
      const displayWiring = wiring ?? existing?.wiring;
      if (displayWiring) {
        flows.set(rel, {
          file: rel,
          wiring: displayWiring,
          status: existing?.status ?? { kind: "starting" },
          undo: undoStack.status(join("wiring", rel)),
        });
        broadcast?.({
          type: "flow.updated",
          file: rel,
          wiring: displayWiring,
          undo: undoStack.status(join("wiring", rel)),
        });
      }
      // markFailedTypecheck mutates the matching flows-map entry's
      // `.status` and broadcasts "flow.status" itself (see the Supervisor
      // constructor's onStatusChange callback below) -- no need to
      // duplicate that here.
      supervisor.markFailedTypecheck(flowName, output);
      return { ok: false, output };
    }
    const recheck = await runTypecheck([flow], DATA_DIR);
    // Always reflect what's actually on disk now, regardless of typecheck
    // outcome — the user's save IS what they see, plus a status badge
    // explaining why it isn't running if it doesn't typecheck.
    flows.set(rel, {
      file: rel,
      wiring,
      status: supervisor.getStatus(flow.name) ?? { kind: "starting" },
      undo: undoStack.status(join("wiring", rel)),
    });
    broadcast?.({
      type: "flow.updated",
      file: rel,
      wiring,
      undo: undoStack.status(join("wiring", rel)),
    });
    if (!recheck.ok) {
      supervisor.markFailedTypecheck(flow.name, recheck.output);
      console.error(
        `[coordinator] ${rel}: typecheck FAILED, flow untouched:\n${recheck.output}`,
      );
      return { ok: false, output: recheck.output };
    }
    console.log(
      wiring.disabled
        ? `[coordinator] ${rel}: typecheck OK, flow "${flow.name}" is disabled`
        : `[coordinator] ${rel}: typecheck OK, restarting flow "${flow.name}"`,
    );
    await applyRunState(path, wiring, flow, { restart: true });
    const updated = flows.get(rel);
    if (updated)
      updated.status = supervisor.getStatus(flow.name) ?? updated.status;
    return { ok: true, output: recheck.output };
  }

  /**
   * Shared by both the fs-watcher and the ws block.write handler.
   *
   * Flows are independent: a block edit that breaks one flow's wiring
   * (e.g. renames a port a wire still references) must not affect any
   * *other* flow's status or leave it un-restarted, even though a single
   * registry rebuild + tsc run necessarily spans every flow at once. This
   * used to mark every flow as failed (`markAllFailedTypecheck`) and
   * restart none of them the moment even one flow broke — so an unrelated,
   * perfectly healthy flow would show a false "failed" status, and
   * subsequently stay stuck on that false status forever once the actually
   * broken flow got fixed through a narrower, single-flow reload path
   * (reloadWiringFile) that never re-touches this flow to clear it. Each
   * flow now gets marked/restarted strictly on its own merits.
   */
  async function reloadBlocksAndRestartAll(
    label?: string,
  ): Promise<TypecheckOutcome> {
    return serializeReload(async () => {
      registry = await discoverBlocks(DATA_DIR);
      const { loaded, failed: failedToLoad } = await loadAllFlows(registry);
      const { ok: succeeded, failed: failedTypecheck } =
        await typecheckIsolated(loaded);

      for (const { file, wiring, error } of failedToLoad) {
        const flowName = wiring?.name ?? basename(file);
        console.error(
          `[coordinator] blocks reload: ${basename(file)} failed to load, flow left untouched:\n${error}`,
        );
        supervisor.markFailedTypecheck(flowName, error);
      }
      for (const { flow, output } of failedTypecheck) {
        console.error(
          `[coordinator] blocks reload: ${flow.name} typecheck FAILED, flow left untouched:\n${output}`,
        );
        supervisor.markFailedTypecheck(flow.name, output);
      }

      if (succeeded.length > 0) {
        broadcast?.({
          type: "palette.updated",
          palette: buildPalette(DATA_DIR, registry),
        });
        await Promise.all(
          succeeded.map(({ file, wiring, flow }) =>
            applyRunState(file, wiring, flow, { restart: true }),
          ),
        );
      }
      console.log(
        `[coordinator] blocks reload: ${succeeded.length}/${loaded.length + failedToLoad.length} flow(s) restarted independently`,
      );

      const failedCount = failedToLoad.length + failedTypecheck.length;
      if (failedCount === 0) return { ok: true, output: "" };
      const output = [
        ...failedToLoad.map(({ file, error }) => `${basename(file)}: ${error}`),
        ...failedTypecheck.map(({ flow, output }) => `${flow.name}: ${output}`),
      ].join("\n\n");
      return { ok: false, output };
    }, label);
  }

  /**
   * The one place a wiring file goes from "doesn't exist" to "running" —
   * can't reuse reloadWiringFile (assumes the supervisor already knows this
   * flow) or restartFlow (a no-op for a flow startFlow was never called
   * for; see supervisor.ts). serializeReload matters here for the same
   * reason it matters for reloadWiringFileInner: this also reads the
   * shared `registry` via assembleFlow, so it needs the same protection
   * against running concurrently with a blocks reload.
   */
  async function createFlow(
    rawName: string,
  ): Promise<{ file: string; wiring: Wiring }> {
    const slug = slugifyName(rawName);
    if (!slug) {
      throw new Error(`"${rawName}" has no usable characters for a flow name`);
    }
    const file = `${slug}.json`;
    const path = join(DATA_DIR, "wiring", file);
    const relPath = join("wiring", file);
    const result = await serializeReload(async () => {
      if (flows.has(file) || (await Bun.file(path).exists())) {
        throw new Error(`a flow named "${file}" already exists`);
      }
      const wiring: Wiring = { name: slug, nodes: {}, wires: [] };
      recentSelfWrites.set(path, Date.now());
      await Bun.write(path, `${JSON.stringify(wiring, null, 2)}\n`);

      const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
      const flow = assembleFlow(wiring, registry, db);
      db.close();
      const check = await runTypecheck([flow], DATA_DIR);
      if (!check.ok) {
        // Can't actually happen for a brand-new empty flow, but stay honest
        // rather than assume — the same gate every other reload path goes
        // through.
        throw new Error(`new flow failed typecheck:\n${check.output}`);
      }

      await supervisor.startFlow(path, flow.name);
      flows.set(file, {
        file,
        wiring,
        status: supervisor.getStatus(flow.name) ?? { kind: "starting" },
        undo: undoStack.status(relPath),
      });
      broadcast?.({
        type: "flow.updated",
        file,
        wiring,
        undo: undoStack.status(relPath),
      });
      console.log(`[coordinator] created flow "${flow.name}" (${file})`);
      return { file, wiring };
    }, `create flow: ${file}`);
    await undoStack.recordEdit(relPath);
    return result;
  }

  /**
   * Unlike createFlow, blocks aren't "started" — they're just definitions
   * that become available in the palette once discovered; nothing
   * analogous to supervisor.startFlow is needed. reloadBlocksAndRestartAll
   * already re-globs data/blocks/*.ts from scratch each time, so it's the
   * one function that correctly picks up a file that didn't exist a moment
   * ago (same guarantee the fs.watcher's own "blocks" path relies on).
   */
  async function createBlock(
    rawName: string,
  ): Promise<{ file: string; source: string }> {
    const slug = slugifyName(rawName);
    if (!slug) {
      throw new Error(`"${rawName}" has no usable characters for a block name`);
    }
    const file = `${slug}.ts`;
    const path = join(DATA_DIR, "blocks", file);
    // registry is keyed by the block's *internal* name (see
    // discoverBlocks), which need not match its filename — check both so a
    // same-name-different-file block can't silently shadow an existing one.
    if (registry.has(slug) || (await Bun.file(path).exists())) {
      throw new Error(`a block named "${slug}" already exists`);
    }
    const repoRoot = join(DATA_DIR, "..");
    const formatted = await formatWithBiome(
      blockSkeleton(slug),
      relative(repoRoot, path),
      repoRoot,
    );
    recentSelfWrites.set(path, Date.now());
    await Bun.write(path, formatted);
    const check = await reloadBlocksAndRestartAll(`create block: ${file}`);
    if (!check.ok) {
      // Can't actually happen for this hand-written skeleton, but stay
      // honest rather than assume — the same gate every other reload path
      // goes through.
      throw new Error(`new block failed typecheck:\n${check.output}`);
    }
    await undoStack.recordEdit(join("blocks", file));
    console.log(`[coordinator] created block "${slug}" (${file})`);
    return { file, source: formatted };
  }

  /**
   * Refuses to delete a block still referenced by any node in any flow —
   * deleting out from under an active wiring would just surface as a
   * "references unknown block" typecheck failure on the next reload (see
   * the comment on serializeReload above), which is a worse experience than
   * failing the delete itself with a clear reason.
   *
   * Deliberately NOT itself wrapped in serializeReload, same as createBlock
   * — reloadBlocksAndRestartAll() already serializes internally. Wrapping
   * this whole function in serializeReload too would queue that inner call
   * behind this function's own outer turn on the same shared chain — but
   * that outer turn is what's awaiting the inner call, so it can never
   * reach its own turn: a self-deadlock that hangs forever with nothing to
   * catch it, silently wedging every future reload (blocks or wiring)
   * behind it until the coordinator is restarted. Found by reproducing
   * exactly that against a live instance, not by inspection.
   */
  async function deleteBlock(file: string): Promise<void> {
    const path = join(DATA_DIR, "blocks", file);
    if (!(await Bun.file(path).exists())) {
      throw new Error(`block file "${file}" does not exist`);
    }
    // registry is keyed by the block's *internal* name, which need not
    // match its filename (see createBlock) — recover it the same way
    // buildPalette does, by recomputing each entry's relative file.
    const blockName = [...registry.entries()].find(([, entry]) => {
      if (entry.origin === "builtin") return false;
      return relative(join(DATA_DIR, "blocks"), entry.modulePath) === file;
    })?.[0];
    if (blockName) {
      for (const entry of flows.values()) {
        for (const [nodeId, node] of Object.entries(entry.wiring.nodes)) {
          if (node.block === blockName) {
            throw new Error(
              `block "${blockName}" is still used by node "${nodeId}" in flow "${entry.wiring.name}" — remove it from the flow first`,
            );
          }
        }
      }
    }
    recentSelfWrites.set(path, Date.now());
    await unlink(path);
    const check = await reloadBlocksAndRestartAll(`delete block: ${file}`);
    if (!check.ok) {
      // Can't actually happen — an unreferenced block's removal can't
      // break a typecheck that never depended on it — but stay honest
      // rather than assume, the same gate every other reload path goes
      // through.
      throw new Error(
        `block deletion left flows failing typecheck:\n${check.output}`,
      );
    }
    undoStack.forget(join("blocks", file));
    console.log(`[coordinator] deleted block "${blockName ?? file}" (${file})`);
  }

  /**
   * Deliberately NOT wrapped in serializeReload itself — handleWiringFileDeleted
   * (defined below) already serializes internally, and double-wrapping would
   * self-deadlock, same reasoning as deleteBlock above. Reusing it here
   * (rather than duplicating the stop-flow/forget-state/broadcast logic)
   * also means an explicit delete and the fs-watcher noticing an external
   * deletion go through the exact same cleanup path.
   */
  async function deleteFlow(file: string): Promise<void> {
    const entry = flows.get(file);
    if (!entry) {
      throw new Error(`unknown wiring file "${file}"`);
    }
    const path = join(DATA_DIR, "wiring", file);
    recentSelfWrites.set(path, Date.now());
    await unlink(path);
    await handleWiringFileDeleted(path, `delete flow: ${file}`);
  }

  // agent/tools.ts's handlers only need agentToolDeps's subset of this
  // object (no supervisor/logBuffer/chatEvents/gitSnapshotter/
  // getSystemStats/queryDb) — reusing it here means the agent's tools (run
  // via dispatchToolCall, relayed from ai-host) and the browser's WS
  // handlers call the exact same functions, inheriting the same typecheck
  // gate/git commit/undo tracking, with nothing duplicated.
  const coordinatorDeps = {
    ...agentToolDeps,
    supervisor,
    logBuffer,
    chatEvents,
    gitSnapshotter,
    restoreFlow,
    getSystemStats: () =>
      collectSystemStats(flows, registry.size, logBuffer.all().length),
    queryDb: async (sql: string) => runReplQuery(replDb, sql),
  };

  const wsServer = startWsServer(WS_PORT, { ...coordinatorDeps, aiHostClient });
  broadcast = wsServer.broadcast;
  console.log(
    `[coordinator] websocket control API on ws://localhost:${WS_PORT}/ws`,
  );

  /** A wiring file that existed a moment ago is now gone from disk — stop
   * its flow-host and drop it from every piece of coordinator state that
   * still remembers it. Without this, deleting a wiring file left its last
   * known status (running, failed-typecheck, whatever) stuck in the flows
   * map and its flow-host subprocess still executing forever, since nothing
   * else ever notices the file is gone. */
  async function handleWiringFileDeleted(
    path: string,
    label?: string,
  ): Promise<void> {
    return serializeReload(
      async () => {
        const rel = basename(path);
        const entry = flows.get(rel);
        if (!entry) return; // already handled, or never existed
        await supervisor.stopFlow(entry.wiring.name);
        flows.delete(rel);
        undoStack.forget(join("wiring", rel));
        recentSelfWrites.delete(path);
        broadcast?.({ type: "flow.removed", file: rel });
        console.log(
          `[coordinator] wiring file deleted, stopped flow "${entry.wiring.name}" (${rel})`,
        );
      },
      label ?? `delete flow: ${basename(path)}`,
    );
  }

  const stopWatcher = startWatcher(DATA_DIR, async (scope) => {
    if (scope.kind === "blocks") {
      // block.write already ran reloadBlocksAndRestartAll() directly; if
      // every file this debounce window saw was that same self-write, skip
      // the redundant second reload+restart-all cycle. A mixed batch (one
      // self-written file plus a genuinely external edit to another) still
      // reloads, same as a lone external edit would.
      const now = Date.now();
      const allSelfWrites = scope.files.every((f) => {
        const at = recentSelfWrites.get(f);
        return at !== undefined && now - at < SELF_WRITE_SUPPRESS_MS;
      });
      if (allSelfWrites) return;
      const names = scope.files.map((f) => basename(f));
      await reloadBlocksAndRestartAll(
        `external edit: blocks (${names.join(", ")})`,
      );
      await Promise.all(
        names.map((name) => undoStack.recordEdit(join("blocks", name))),
      );
    } else {
      const suppressedAt = recentSelfWrites.get(scope.file);
      if (
        suppressedAt !== undefined &&
        Date.now() - suppressedAt < SELF_WRITE_SUPPRESS_MS
      )
        return;
      if (!(await Bun.file(scope.file).exists())) {
        await handleWiringFileDeleted(
          scope.file,
          `external delete: ${basename(scope.file)}`,
        );
        return;
      }
      try {
        const name = basename(scope.file);
        await reloadWiringFile(scope.file, `external edit: ${name}`);
        await undoStack.recordEdit(join("wiring", name));
      } catch (err) {
        console.error(`[coordinator] failed to read ${scope.file}: ${err}`);
      }
    }
  });

  async function shutdown(): Promise<void> {
    stopWatcher();
    wsServer.server.stop();
    await supervisor.stopAll();
    aiHostClient.stop();
    replDb.close();
    process.exit(0);
  }
  // Both signals matter: interactive Ctrl-C sends SIGINT, but process
  // managers (and plain `kill`/`pkill` with no args) send SIGTERM by
  // default — without a handler for it, the coordinator would die without
  // ever calling supervisor.stopAll(), orphaning every flow-host child.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[coordinator] fatal:", err);
  process.exit(1);
});
