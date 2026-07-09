import { describe, expect, test } from "bun:test";
import type { FlowEntry } from "flowbun/ws";
import { collectSystemStats, countBunProcesses } from "./system-stats";

function flowEntry(file: string, kind: string): FlowEntry {
  const status =
    kind === "running"
      ? ({ kind: "running", pid: 1, since: 0 } as const)
      : ({ kind } as FlowEntry["status"]);
  return {
    file,
    wiring: { name: file, nodes: {}, wires: [] },
    status,
    undo: { canUndo: false, canRedo: false },
  };
}

describe("collectSystemStats", () => {
  test("an empty flows map reports zero flows and an empty status tally", async () => {
    const stats = await collectSystemStats(new Map(), 0, 0);
    expect(stats.flows.total).toBe(0);
    expect(stats.flows.byStatus).toEqual({});
  });

  test("tallies flows by status kind", async () => {
    const flows = new Map([
      ["a.json", flowEntry("a.json", "running")],
      ["b.json", flowEntry("b.json", "running")],
      ["c.json", flowEntry("c.json", "starting")],
    ]);
    const stats = await collectSystemStats(flows, 0, 0);
    expect(stats.flows.total).toBe(3);
    expect(stats.flows.byStatus).toEqual({ running: 2, starting: 1 });
  });

  test("passes palette block count and log buffer size straight through", async () => {
    const stats = await collectSystemStats(new Map(), 7, 42);
    expect(stats.palette.blockCount).toBe(7);
    expect(stats.logBuffer.size).toBe(42);
  });

  test("coordinator identity fields reflect the actual running process", async () => {
    const stats = await collectSystemStats(new Map(), 0, 0);
    expect(stats.coordinator.pid).toBe(process.pid);
    expect(stats.coordinator.bunVersion).toBe(Bun.version);
    expect(stats.coordinator.memory.rss).toBeGreaterThan(0);
  });

  test("system section reports plausible values", async () => {
    const stats = await collectSystemStats(new Map(), 0, 0);
    expect(stats.system.cpuCount).toBeGreaterThan(0);
    expect(stats.system.totalMemBytes).toBeGreaterThan(0);
    expect(stats.system.loadAvg).toHaveLength(3);
  });
});

describe("countBunProcesses", () => {
  test("returns a non-negative count without throwing", async () => {
    // Best-effort by design (see its own doc comment) — 0 on platforms
    // without /proc, so this can't assert an exact value portably. The
    // test process itself is a `bun test` run, so on Linux this is
    // reliably >= 1, but the contract this test actually guards is "never
    // throws, always a sane number."
    const count = await countBunProcesses();
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });
});
