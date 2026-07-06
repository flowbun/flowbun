// sqlite-worker.ts
//
// Runs INSIDE a Worker (spawned by sqlite-in-worker.ts). Confirms that
// `import { Database } from "bun:sqlite"` works inside a worker thread and
// that basic operations against both an in-memory DB and a temp-file DB
// don't crash the process.

import { Database } from "bun:sqlite";

type Result = { ok: boolean; step: string; detail: string };
const results: Result[] = [];

function record(step: string, fn: () => string) {
  try {
    const detail = fn();
    results.push({ ok: true, step, detail });
  } catch (err) {
    results.push({ ok: false, step, detail: err instanceof Error ? err.message : String(err) });
  }
}

record("import bun:sqlite", () => `Database constructor available: ${typeof Database === "function"}`);

record("open in-memory db", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO t (name) VALUES (?)", ["from-worker"]);
  const row = db.query("SELECT * FROM t WHERE id = 1").get() as any;
  db.close();
  return `row=${JSON.stringify(row)}`;
});

record("open temp-file db", () => {
  const path = `/tmp/flowbun-spike-sqlite-${process.pid}-${Date.now()}.sqlite`;
  const db = new Database(path);
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  db.run("INSERT INTO t (val) VALUES (?)", ["file-backed"]);
  const row = db.query("SELECT * FROM t WHERE id = 1").get() as any;
  db.close();
  try {
    require("node:fs").unlinkSync(path);
  } catch {
    // ignore cleanup failure
  }
  return `row=${JSON.stringify(row)}, path=${path}`;
});

postMessage({ type: "sqlite-results", at: Date.now(), payload: results });
