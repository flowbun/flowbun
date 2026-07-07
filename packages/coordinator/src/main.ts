import { join } from "node:path";
import type { LoadedFlow } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  runTypecheck,
} from "flowbun";
import { HaRelay } from "./ha-relay";
import { LogBuffer } from "./log-buffer";
import { Supervisor } from "./supervisor";
import { startWatcher } from "./watcher";

const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");

interface FileFlow {
  file: string;
  flow: LoadedFlow;
}

async function loadAllFlows(): Promise<FileFlow[]> {
  const registry = await discoverBlocks(DATA_DIR);
  const wiringDir = join(DATA_DIR, "wiring");
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.json").scan({ cwd: wiringDir }))
    files.push(join(wiringDir, f));

  const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
  const out: FileFlow[] = [];
  for (const file of files)
    out.push({
      file,
      flow: assembleFlow(await loadWiringFile(file), registry, db),
    });
  db.close(); // transient — only needed to build LoadedFlow shapes for the typecheck gate
  return out;
}

async function main(): Promise<void> {
  const logBuffer = new LogBuffer();
  const haRelay = new HaRelay();
  const supervisor = new Supervisor(DATA_DIR, haRelay, logBuffer);

  const all = await loadAllFlows();
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
  for (const { file, flow } of all) await supervisor.startFlow(file, flow.name);

  const stopWatcher = startWatcher(DATA_DIR, async (scope) => {
    if (scope.kind === "blocks") {
      const reloaded = await loadAllFlows();
      const recheck = await runTypecheck(
        reloaded.map((f) => f.flow),
        DATA_DIR,
      );
      if (!recheck.ok) {
        supervisor.markAllFailedTypecheck(recheck.output);
        console.error(
          `[coordinator] blocks reload: typecheck FAILED, ALL flows left untouched:\n${recheck.output}`,
        );
        return;
      }
      console.log(
        "[coordinator] blocks reload: typecheck OK, restarting every flow (decision: reload granularity)",
      );
      await Promise.all(
        reloaded.map(({ flow }) => supervisor.restartFlow(flow.name)),
      );
    } else {
      let wiring: Awaited<ReturnType<typeof loadWiringFile>>;
      try {
        wiring = await loadWiringFile(scope.file);
      } catch (err) {
        console.error(`[coordinator] failed to read ${scope.file}: ${err}`);
        return;
      }
      const registry = await discoverBlocks(DATA_DIR);
      const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
      const flow = assembleFlow(wiring, registry, db);
      db.close();
      const recheck = await runTypecheck([flow], DATA_DIR);
      if (!recheck.ok) {
        supervisor.markFailedTypecheck(flow.name, recheck.output);
        console.error(
          `[coordinator] ${scope.file}: typecheck FAILED, flow untouched:\n${recheck.output}`,
        );
        return;
      }
      console.log(
        `[coordinator] ${scope.file}: typecheck OK, restarting flow "${flow.name}"`,
      );
      await supervisor.restartFlow(flow.name);
    }
  });

  async function shutdown(): Promise<void> {
    stopWatcher();
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
