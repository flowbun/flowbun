import { basename, join } from "node:path";
import type { LoadedFlow, Wiring } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  runTypecheck,
} from "flowbun";
import type { FlowEntry, ServerToClient, TypecheckOutcome } from "flowbun/ws";
import { HaRelay } from "./ha-relay";
import { LogBuffer } from "./log-buffer";
import { Supervisor } from "./supervisor";
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
  let broadcast: ((msg: ServerToClient) => void) | null = null;
  const recentSelfWrites = new Map<string, number>(); // absolute wiring file path -> Date.now()

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
    });
  }

  // Serializes reloadWiringFile calls per file: without this, a burst of
  // rapid edits (each spawning an async typecheck + possible restart) can
  // complete out of order, letting a reload that started earlier — but
  // finishes later — clobber `flows`/broadcast with stale wiring even
  // though a more recent reload already landed the correct state. Queuing
  // guarantees completion order matches initiation order, so the last
  // reload to finish is always the one for the last edit made. Found and
  // fixed by actually reproducing it: three rapid UI edits left the
  // coordinator's in-memory wiring showing a node already deleted on disk.
  const reloadChains = new Map<string, Promise<void>>();

  async function reloadWiringFile(path: string): Promise<TypecheckOutcome> {
    const rel = basename(path);
    const previous = reloadChains.get(rel) ?? Promise.resolve();
    let result!: TypecheckOutcome;
    const chained = previous.then(async () => {
      result = await reloadWiringFileInner(path);
    });
    reloadChains.set(rel, chained);
    await chained;
    return result;
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
    });
    broadcast?.({ type: "flow.updated", file: rel, wiring });
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
  }

  const wsServer = startWsServer(WS_PORT, {
    dataDir: DATA_DIR,
    supervisor,
    logBuffer,
    flows,
    getPalette: () => buildPalette(DATA_DIR, registry),
    reloadWiringFile,
    reloadBlocksAndRestartAll,
  });
  broadcast = wsServer.broadcast;
  console.log(
    `[coordinator] websocket control API on ws://localhost:${WS_PORT}/ws`,
  );

  const stopWatcher = startWatcher(DATA_DIR, async (scope) => {
    if (scope.kind === "blocks") {
      await reloadBlocksAndRestartAll();
    } else {
      const suppressedAt = recentSelfWrites.get(scope.file);
      if (
        suppressedAt !== undefined &&
        Date.now() - suppressedAt < SELF_WRITE_SUPPRESS_MS
      )
        return;
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
