// run-test.ts
//
// Driver for S5: spawns NUM_WORKERS real OS processes (via Bun.spawn, not
// Worker threads) that all open the SAME sqlite db file concurrently and
// hammer a small set of shared rows with UPDATE ... WHERE id = ? wrapped in
// BEGIN IMMEDIATE transactions. Runs two phases:
//
//   1. no busy_timeout set at all      -> expect to observe SQLITE_BUSY
//   2. PRAGMA busy_timeout = 5000       -> expect SQLITE_BUSY to (mostly)
//                                          disappear because sqlite retries
//                                          internally
//
// After each phase, verifies PRAGMA integrity_check and that the sum of all
// counter values equals the sum of "succeeded" writes reported by workers
// (i.e. no silently lost writes), then reports throughput.

import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { verifyDb } from "./verify.ts";

const DIR = import.meta.dir;
const DB_PATH = path.join(DIR, "test.db");
const NUM_WORKERS = 5;
const DURATION_MS = 8000;
const COUNTER_IDS = ["c0", "c1", "c2"];

function cleanupDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function setupDb() {
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  const insert = db.query("INSERT INTO counters (id, value) VALUES (?, 0)");
  for (const id of COUNTER_IDS) insert.run(id);
  db.close();
}

interface WorkerResult {
  workerId: number;
  attempted: number;
  succeeded: number;
  busyErrors: number;
  otherErrors: number;
  perCounterSucceeded: Record<string, number>;
  errorSamples: string[];
  elapsedMs: number;
}

async function runPhase(label: string, busyTimeoutMs: number) {
  console.log(`\n=== Phase: ${label} (busy_timeout=${busyTimeoutMs}, workers=${NUM_WORKERS}, duration=${DURATION_MS}ms) ===`);
  cleanupDbFiles();
  setupDb();

  const resultsDir = path.join(DIR, `results-${label}`);
  mkdirSync(resultsDir, { recursive: true });

  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const resultPaths: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < NUM_WORKERS; i++) {
    const resultPath = path.join(resultsDir, `worker-${i}.json`);
    resultPaths.push(resultPath);
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        path.join(DIR, "worker.ts"),
        DB_PATH,
        String(i),
        String(DURATION_MS),
        String(busyTimeoutMs),
        resultPath,
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    procs.push(proc);
  }

  // Check mid-run (not after exit) whether -wal/-shm files exist: sqlite
  // auto-checkpoints and deletes them when the last connection closes
  // cleanly, so checking after all workers exit would wrongly show "false".
  await Bun.sleep(Math.min(1500, DURATION_MS / 2));
  const walExists = existsSync(DB_PATH + "-wal");
  const shmExists = existsSync(DB_PATH + "-shm");

  const exitCodes = await Promise.all(procs.map((p) => p.exited));
  const wallMs = Date.now() - t0;

  if (exitCodes.some((c) => c !== 0)) {
    console.error(`WARNING: some worker processes exited non-zero: ${exitCodes.join(",")}`);
  }

  const results: WorkerResult[] = await Promise.all(
    resultPaths.map(async (p) => JSON.parse(await Bun.file(p).text()))
  );

  const { integrityOk, integrityRaw, rows, totalValue } = verifyDb(DB_PATH);

  const totalAttempted = results.reduce((s, r) => s + r.attempted, 0);
  const totalSucceeded = results.reduce((s, r) => s + r.succeeded, 0);
  const totalBusy = results.reduce((s, r) => s + r.busyErrors, 0);
  const totalOther = results.reduce((s, r) => s + r.otherErrors, 0);

  // Per-counter expected vs actual: sum of succeeded writes per id across
  // all workers should equal that row's stored value.
  const perCounterExpected: Record<string, number> = Object.fromEntries(COUNTER_IDS.map((id) => [id, 0]));
  for (const r of results) {
    for (const id of COUNTER_IDS) {
      perCounterExpected[id] += r.perCounterSucceeded[id] ?? 0;
    }
  }
  const perCounterActual: Record<string, number> = Object.fromEntries(rows.map((r) => [r.id, r.value]));
  const perCounterMatch = COUNTER_IDS.every((id) => perCounterExpected[id] === perCounterActual[id]);

  console.log("Per-worker results:");
  for (const r of results) {
    console.log(
      `  worker ${r.workerId}: attempted=${r.attempted} succeeded=${r.succeeded} busyErrors=${r.busyErrors} otherErrors=${r.otherErrors} elapsedMs=${r.elapsedMs}`
    );
    if (r.errorSamples.length) console.log(`    sample errors: ${r.errorSamples.join(" | ")}`);
  }
  console.log("Counter rows (final):", rows);
  console.log(`WAL file present during run: ${walExists}, SHM file present: ${shmExists}`);
  console.log(`integrity_check: ${integrityRaw}`);
  console.log(
    `Totals: attempted=${totalAttempted} succeeded=${totalSucceeded} busyErrors=${totalBusy} otherErrors=${totalOther}`
  );
  console.log(
    `Sum of counter values=${totalValue} vs total succeeded writes=${totalSucceeded} -> ${
      totalValue === totalSucceeded ? "MATCH" : "MISMATCH"
    }`
  );
  console.log(`Per-counter expected vs actual match: ${perCounterMatch}`, perCounterExpected, perCounterActual);
  console.log(`Wall time=${wallMs}ms, throughput=${(totalSucceeded / (wallMs / 1000)).toFixed(1)} writes/sec`);

  return {
    label,
    busyTimeoutMs,
    numWorkers: NUM_WORKERS,
    durationMs: DURATION_MS,
    wallMs,
    results,
    rows,
    walExists,
    shmExists,
    integrityOk,
    integrityRaw,
    totalAttempted,
    totalSucceeded,
    totalBusy,
    totalOther,
    totalValue,
    valuesMatch: totalValue === totalSucceeded,
    perCounterMatch,
    throughputWritesPerSec: totalSucceeded / (wallMs / 1000),
  };
}

const noTimeout = await runPhase("no-busy-timeout", 0);
const withTimeout = await runPhase("busy-timeout-5000", 5000);

const summary = { noTimeout, withTimeout };
await Bun.write(path.join(DIR, "summary.json"), JSON.stringify(summary, null, 2));

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
