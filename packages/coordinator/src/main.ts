import { unlink } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { LoadedFlow, Wiring } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  runTypecheck,
} from "flowbun";
import type { FlowEntry, ServerToClient, TypecheckOutcome } from "flowbun/ws";
import { runReplQuery } from "./db-repl";
import { formatWithBiome } from "./format-block";
import { HaRelay } from "./ha-relay";
import { LogBuffer } from "./log-buffer";
import { createReloadSerializer } from "./serialize-reload";
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
): Promise<FileFlow[]> {
  const wiringDir = join(DATA_DIR, "wiring");
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.json").scan({ cwd: wiringDir }))
    files.push(join(wiringDir, f));

  const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
  const out: FileFlow[] = [];
  for (const file of files) {
    const wiring = await loadWiringFile(file);
    out.push({ file, wiring, flow: assembleFlow(wiring, registry, db) });
  }
  db.close(); // transient — only needed to build LoadedFlow shapes for the typecheck gate
  return out;
}

async function main(): Promise<void> {
  const logBuffer = new LogBuffer();
  const haRelay = new HaRelay();
  const flows = new Map<string, FlowEntry>();
  const undoStack = new UndoStack();
  let broadcast: ((msg: ServerToClient) => void) | null = null;
  const recentSelfWrites = new Map<string, number>(); // absolute wiring/block file path -> Date.now()

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
    haRelay,
    logBuffer,
    (flow, status) => {
      for (const entry of flows.values()) {
        if (entry.wiring.name === flow) entry.status = status;
      }
      broadcast?.({ type: "flow.status", flow, status });
    },
  );

  let registry = await discoverBlocks(DATA_DIR);
  const all = await loadAllFlows(registry);
  const check = await runTypecheck(
    all.map((f) => f.flow),
    DATA_DIR,
  );
  if (!check.ok) {
    console.error(`[coordinator] initial typecheck FAILED:\n${check.output}`);
    process.exit(1); // nothing running yet — no "leave the old one alone" concern
  }
  console.log(
    `[coordinator] initial typecheck OK (${Math.round(check.durationMs)}ms)`,
  );
  for (const { file, wiring, flow } of all) {
    await supervisor.startFlow(file, flow.name);
    const rel = basename(file);
    flows.set(rel, {
      file: rel,
      wiring,
      status: supervisor.getStatus(flow.name) ?? { kind: "starting" },
      undo: undoStack.status(rel),
    });
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
  const serializeReload = createReloadSerializer();

  async function reloadWiringFile(path: string): Promise<TypecheckOutcome> {
    return serializeReload(() => reloadWiringFileInner(path));
  }

  async function reloadWiringFileInner(
    path: string,
  ): Promise<TypecheckOutcome> {
    recentSelfWrites.set(path, Date.now());
    const wiring = await loadWiringFile(path);
    const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
    const flow = assembleFlow(wiring, registry, db);
    db.close();
    const recheck = await runTypecheck([flow], DATA_DIR);
    const rel = basename(path);
    // Always reflect what's actually on disk now, regardless of typecheck
    // outcome — the user's save IS what they see, plus a status badge
    // explaining why it isn't running if it doesn't typecheck.
    flows.set(rel, {
      file: rel,
      wiring,
      status: supervisor.getStatus(flow.name) ?? { kind: "starting" },
      undo: undoStack.status(rel),
    });
    broadcast?.({
      type: "flow.updated",
      file: rel,
      wiring,
      undo: undoStack.status(rel),
    });
    if (!recheck.ok) {
      supervisor.markFailedTypecheck(flow.name, recheck.output);
      console.error(
        `[coordinator] ${rel}: typecheck FAILED, flow untouched:\n${recheck.output}`,
      );
      return { ok: false, output: recheck.output };
    }
    console.log(
      `[coordinator] ${rel}: typecheck OK, restarting flow "${flow.name}"`,
    );
    await supervisor.restartFlow(flow.name);
    const updated = flows.get(rel);
    if (updated)
      updated.status = supervisor.getStatus(flow.name) ?? updated.status;
    return { ok: true, output: recheck.output };
  }

  /** Shared by both the fs-watcher and the ws block.write handler. */
  async function reloadBlocksAndRestartAll(): Promise<TypecheckOutcome> {
    return serializeReload(async () => {
      registry = await discoverBlocks(DATA_DIR);
      const reloaded = await loadAllFlows(registry);
      const recheck = await runTypecheck(
        reloaded.map((f) => f.flow),
        DATA_DIR,
      );
      if (!recheck.ok) {
        supervisor.markAllFailedTypecheck(recheck.output);
        console.error(
          `[coordinator] blocks reload: typecheck FAILED, ALL flows left untouched:\n${recheck.output}`,
        );
        return { ok: false, output: recheck.output };
      }
      console.log(
        "[coordinator] blocks reload: typecheck OK, restarting every flow (decision: reload granularity)",
      );
      broadcast?.({
        type: "palette.updated",
        palette: buildPalette(DATA_DIR, registry),
      });
      await Promise.all(
        reloaded.map(({ flow }) => supervisor.restartFlow(flow.name)),
      );
      return { ok: true, output: recheck.output };
    });
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
    return serializeReload(async () => {
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
        undo: undoStack.status(file),
      });
      broadcast?.({
        type: "flow.updated",
        file,
        wiring,
        undo: undoStack.status(file),
      });
      console.log(`[coordinator] created flow "${flow.name}" (${file})`);
      return { file, wiring };
    });
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
    const check = await reloadBlocksAndRestartAll();
    if (!check.ok) {
      // Can't actually happen for this hand-written skeleton, but stay
      // honest rather than assume — the same gate every other reload path
      // goes through.
      throw new Error(`new block failed typecheck:\n${check.output}`);
    }
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
      if (entry.modulePath.startsWith("flowbun/")) return false;
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
    const check = await reloadBlocksAndRestartAll();
    if (!check.ok) {
      // Can't actually happen — an unreferenced block's removal can't
      // break a typecheck that never depended on it — but stay honest
      // rather than assume, the same gate every other reload path goes
      // through.
      throw new Error(
        `block deletion left flows failing typecheck:\n${check.output}`,
      );
    }
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
    await handleWiringFileDeleted(path);
  }

  const wsServer = startWsServer(WS_PORT, {
    dataDir: DATA_DIR,
    repoRoot: join(DATA_DIR, ".."),
    supervisor,
    logBuffer,
    flows,
    undoStack,
    getPalette: () => buildPalette(DATA_DIR, registry),
    reloadWiringFile,
    reloadBlocksAndRestartAll,
    createFlow,
    createBlock,
    deleteBlock,
    deleteFlow,
    listHassEntities: () => haRelay.listEntities(),
    markSelfWrite: (path) => recentSelfWrites.set(path, Date.now()),
    getSystemStats: () =>
      collectSystemStats(flows, registry.size, logBuffer.all().length),
    queryDb: async (sql) => runReplQuery(replDb, sql),
  });
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
  async function handleWiringFileDeleted(path: string): Promise<void> {
    return serializeReload(async () => {
      const rel = basename(path);
      const entry = flows.get(rel);
      if (!entry) return; // already handled, or never existed
      await supervisor.stopFlow(entry.wiring.name);
      flows.delete(rel);
      undoStack.forget(rel);
      recentSelfWrites.delete(path);
      broadcast?.({ type: "flow.removed", file: rel });
      console.log(
        `[coordinator] wiring file deleted, stopped flow "${entry.wiring.name}" (${rel})`,
      );
    });
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
      await reloadBlocksAndRestartAll();
    } else {
      const suppressedAt = recentSelfWrites.get(scope.file);
      if (
        suppressedAt !== undefined &&
        Date.now() - suppressedAt < SELF_WRITE_SUPPRESS_MS
      )
        return;
      if (!(await Bun.file(scope.file).exists())) {
        await handleWiringFileDeleted(scope.file);
        return;
      }
      try {
        await reloadWiringFile(scope.file);
      } catch (err) {
        console.error(`[coordinator] failed to read ${scope.file}: ${err}`);
      }
    }
  });

  async function shutdown(): Promise<void> {
    stopWatcher();
    wsServer.server.stop();
    await supervisor.stopAll();
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
