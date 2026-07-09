import type { Database } from "bun:sqlite";
import type { DbQueryOutcome } from "flowbun/ws";

function serializeCell(value: unknown): unknown {
  // The connection is opened with safeIntegers: true (see main.ts) so that
  // huge integers round-trip faithfully instead of silently losing
  // precision — but that means bun:sqlite returns *every* integer as a
  // bigint, not just the ones that need it, and JSON.stringify throws on
  // any bigint outright. Converting back to a plain number whenever that's
  // lossless keeps ordinary small integers (ids, counts) displaying as
  // numbers rather than quoted strings; only the rare value that's
  // actually too big to survive as a JS number falls back to a string.
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  // The state table never stores blobs (its own `value` column is always
  // JSON text — see state/db.ts's schema), but this is a genuine SQL
  // terminal against a schema the user can freely CREATE TABLE into, so a
  // blob column is a real possibility, not a hypothetical.
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`;
  return value;
}

/**
 * Runs one arbitrary SQL statement typed into the log panel's "DB" tab and
 * normalizes the result into a uniform shape regardless of statement kind
 * — this is a genuine SQL terminal, not a query-builder, so anything the
 * user types (SELECT, PRAGMA, INSERT ... RETURNING, CREATE TABLE, ...)
 * needs to work.
 *
 * `db.query(sql)` alone — before executing anything — already reveals
 * whether the compiled statement produces a result set at all, via
 * `columnNames`: a genuine SELECT/PRAGMA/RETURNING has real column names,
 * a bare INSERT/UPDATE/DELETE/DDL statement has none. Branching on that,
 * rather than always calling `.all()`/`.values()`, is what avoids calling
 * both the row-fetching method and `.run()` on the same statement — which
 * would execute a write statement twice. Throws synchronously on invalid
 * SQL (from `db.query(sql)` itself, before any execution) — the caller
 * catches this the same way as every other ws request handler.
 */
export function runReplQuery(db: Database, sql: string): DbQueryOutcome {
  const stmt = db.query(sql);
  if (stmt.columnNames.length > 0) {
    const rows = stmt.values().map((row) => row.map(serializeCell));
    return { columns: stmt.columnNames, rows, rowCount: rows.length };
  }
  const changes = stmt.run();
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    changes: changes.changes,
    lastInsertRowid: String(changes.lastInsertRowid),
  };
}
