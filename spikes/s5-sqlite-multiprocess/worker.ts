// worker.ts
//
// Spawned as an independent OS process (via Bun.spawn in run-test.ts).
// Opens the SAME sqlite db file as every other worker and hammers a small
// set of rows with read-modify-write UPDATEs wrapped in BEGIN IMMEDIATE
// transactions, for a fixed duration. Records attempted/succeeded/busy/other
// counts and writes them to a per-worker JSON result file so the driver
// process can aggregate without relying on stdout interleaving.
//
// Usage:
//   bun run worker.ts <dbPath> <workerId> <durationMs> <busyTimeoutMs> <resultPath>
//
// busyTimeoutMs === 0 means "do not set PRAGMA busy_timeout at all" (sqlite
// default is 0, i.e. fail immediately with SQLITE_BUSY instead of retrying).

import { Database } from "bun:sqlite";

const [, , dbPath, workerIdStr, durationMsStr, busyTimeoutStr, resultPath] = process.argv;

const workerId = parseInt(workerIdStr, 10);
const durationMs = parseInt(durationMsStr, 10);
const busyTimeoutMs = parseInt(busyTimeoutStr, 10);

if (!dbPath || Number.isNaN(workerId) || Number.isNaN(durationMs) || Number.isNaN(busyTimeoutMs) || !resultPath) {
  console.error("usage: worker.ts <dbPath> <workerId> <durationMs> <busyTimeoutMs> <resultPath>");
  process.exit(1);
}

const COUNTER_IDS = ["c0", "c1", "c2"];

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
if (busyTimeoutMs > 0) {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
}

const updateStmt = db.query("UPDATE counters SET value = value + 1 WHERE id = ?");

let attempted = 0;
let succeeded = 0;
let busyErrors = 0;
let otherErrors = 0;
const perCounterSucceeded: Record<string, number> = Object.fromEntries(COUNTER_IDS.map((id) => [id, 0]));
const errorSamples: string[] = [];

function doUpdate(id: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    updateStmt.run(id);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback can itself fail if the BEGIN IMMEDIATE never succeeded; ignore
    }
    throw e;
  }
}

const start = Date.now();
while (Date.now() - start < durationMs) {
  const id = COUNTER_IDS[attempted % COUNTER_IDS.length];
  attempted++;
  try {
    doUpdate(id);
    succeeded++;
    perCounterSucceeded[id]++;
  } catch (e: any) {
    const code = e?.code ?? "";
    const msg = String(e?.message ?? e);
    if (code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(msg)) {
      busyErrors++;
      if (errorSamples.length < 3) errorSamples.push(`${code}: ${msg}`);
    } else {
      otherErrors++;
      if (errorSamples.length < 3) errorSamples.push(`${code}: ${msg}`);
    }
  }
}
const elapsedMs = Date.now() - start;

db.close();

await Bun.write(
  resultPath,
  JSON.stringify(
    {
      workerId,
      attempted,
      succeeded,
      busyErrors,
      otherErrors,
      perCounterSucceeded,
      errorSamples,
      elapsedMs,
    },
    null,
    2
  )
);
