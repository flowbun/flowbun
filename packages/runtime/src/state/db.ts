import { Database } from "bun:sqlite";

export function openStateDb(path: string): Database {
  const db = new Database(path, { create: true });
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
