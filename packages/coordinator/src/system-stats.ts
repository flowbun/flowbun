import { readdir } from "node:fs/promises";
import { cpus, freemem, loadavg, uptime as osUptime, totalmem } from "node:os";
import type { FlowEntry, SystemStats } from "flowbun/ws";

/**
 * Counts OS-level processes whose executable is literally "bun" — the
 * coordinator itself plus one per running flow-host (each is its own
 * separate `bun run` subprocess; see supervisor.ts's spawn()). Reads
 * /proc directly rather than shelling out to `ps` (not even installed in
 * this project's Docker image, confirmed via `docker exec ... ps` failing
 * with "executable file not found") — avoids a subprocess spawn just to
 * gather one number, at the cost of being Linux-only, which is what this
 * always actually runs under (the Docker image and the podman dev host
 * both are). Best-effort: 0, not a thrown error, if /proc isn't there at
 * all — this is one optional telemetry number, not worth failing the
 * whole stats request over.
 */
export async function countBunProcesses(): Promise<number> {
  try {
    const entries = await readdir("/proc");
    const pids = entries.filter((d) => /^\d+$/.test(d));
    const comms = await Promise.all(
      pids.map(async (pid) => {
        try {
          return (await Bun.file(`/proc/${pid}/comm`).text()).trim();
        } catch {
          return ""; // process exited between listing and reading — skip it
        }
      }),
    );
    return comms.filter((c) => c === "bun").length;
  } catch {
    return 0;
  }
}

/** Everything collectSystemStats can gather on its own — the caller
 * (ws-server.ts's "system.stats" handler) fills in `websocket`, the one
 * piece only it knows (the live socket count lives in its own closure). */
export type CoordinatorStats = Omit<SystemStats, "websocket">;

export async function collectSystemStats(
  flows: ReadonlyMap<string, FlowEntry>,
  paletteBlockCount: number,
  logBufferSize: number,
): Promise<CoordinatorStats> {
  const flowList = [...flows.values()];
  const byStatus: Record<string, number> = {};
  for (const f of flowList) {
    byStatus[f.status.kind] = (byStatus[f.status.kind] ?? 0) + 1;
  }
  const mem = process.memoryUsage();
  const bunProcessCount = await countBunProcesses();

  return {
    coordinator: {
      pid: process.pid,
      uptimeSec: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      bunVersion: Bun.version,
    },
    bunProcessCount,
    flows: { total: flowList.length, byStatus },
    system: {
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
      loadAvg: loadavg() as [number, number, number],
      cpuCount: cpus().length,
      uptimeSec: osUptime(),
    },
    logBuffer: { size: logBufferSize },
    palette: { blockCount: paletteBlockCount },
  };
}
