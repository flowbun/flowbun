import type { Database } from "bun:sqlite";
import type { StateScope } from "../block";

export type StateScopeKind = "block" | "flow" | "global";

export function makeStateScope(
  db: Database,
  scope: StateScopeKind,
  scopeKey: string,
): StateScope {
  const getStmt = db.query<{ value: string }, [string, string, string]>(
    "SELECT value FROM state WHERE scope = ? AND scope_key = ? AND key = ?",
  );
  const setStmt = db.query<unknown, [string, string, string, string, number]>(
    `INSERT INTO state (scope, scope_key, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_key, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const delStmt = db.query<unknown, [string, string, string]>(
    "DELETE FROM state WHERE scope = ? AND scope_key = ? AND key = ?",
  );

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const row = getStmt.get(scope, scopeKey, key);
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      setStmt.run(scope, scopeKey, key, JSON.stringify(value), Date.now());
    },
    async delete(key: string): Promise<void> {
      delStmt.run(scope, scopeKey, key);
    },
  };
}

export function blockScopeKey(flowName: string, nodeId: string): string {
  return `${flowName}.${nodeId}`;
}
