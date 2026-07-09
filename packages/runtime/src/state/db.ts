import { Database } from "bun:sqlite";

/**
 * `safeIntegers` defaults off (unchanged existing behavior for block/flow
 * state reads — none of it touches raw INTEGER columns directly, `value`
 * is always JSON text) — pass `true` for a connection that needs to
 * faithfully round-trip arbitrary large integers instead of silently
 * losing precision past Number.MAX_SAFE_INTEGER (the coordinator's DB
 * REPL is the one caller that does, since a user can query anything).
 */
export function openStateDb(
  path: string,
  options?: { safeIntegers?: boolean },
): Database {
  const db = new Database(path, {
    create: true,
    safeIntegers: options?.safeIntegers ?? false,
  });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      scope      TEXT NOT NULL,
      scope_key  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, scope_key, key)
    ) WITHOUT ROWID;
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_state_scope_key ON state (scope, scope_key);",
  );
  return db;
}
