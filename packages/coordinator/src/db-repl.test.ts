import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runReplQuery } from "./db-repl";

function freshDb(): Database {
  // safeIntegers: true, matching the coordinator's actual REPL connection
  // (see main.ts) — without it, bun:sqlite silently rounds integers past
  // Number.MAX_SAFE_INTEGER to the nearest representable float instead of
  // returning a bigint, which is a worse outcome for a tool whose entire
  // point is faithfully showing what's actually in the database.
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("INSERT INTO t (name) VALUES ('a'), ('b')");
  return db;
}

describe("runReplQuery", () => {
  test("a SELECT returns columns aligned with row arrays", () => {
    const db = freshDb();
    const result = runReplQuery(db, "SELECT id, name FROM t ORDER BY id");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(result.rowCount).toBe(2);
  });

  test("a SELECT with no matching rows returns an empty row set, not an error", () => {
    const db = freshDb();
    const result = runReplQuery(db, "SELECT * FROM t WHERE id = 999");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  test("CREATE TABLE has no columns and doesn't throw", () => {
    const db = freshDb();
    const result = runReplQuery(db, "CREATE TABLE u (id INTEGER)");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("INSERT reports changes and lastInsertRowid, and actually persists", () => {
    const db = freshDb();
    const result = runReplQuery(db, "INSERT INTO t (name) VALUES ('c')");
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe("3");
    expect(result.columns).toEqual([]);
    // Executed exactly once — a second SELECT sees exactly one new row, not
    // two (which double-execution via calling both .values() and .run()
    // on the same statement would produce).
    const after = runReplQuery(db, "SELECT count(*) AS n FROM t");
    expect(after.rows).toEqual([[3]]);
  });

  test("INSERT ... RETURNING behaves like a SELECT (has columns, real rows)", () => {
    const db = freshDb();
    const result = runReplQuery(
      db,
      "INSERT INTO t (name) VALUES ('c') RETURNING id, name",
    );
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([[3, "c"]]);
  });

  test("PRAGMA behaves like a SELECT", () => {
    const db = freshDb();
    const result = runReplQuery(db, "PRAGMA table_info(t)");
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.rowCount).toBe(2); // t has 2 columns: id, name
  });

  test("invalid SQL throws rather than returning a fabricated result", () => {
    const db = freshDb();
    expect(() => runReplQuery(db, "SELEKT * FROM t")).toThrow();
  });

  test("an integer too large for a safe JS number comes back as a string, not a bigint", () => {
    const db = freshDb();
    // Larger than Number.MAX_SAFE_INTEGER (2^53 - 1) — bun:sqlite returns
    // this as a bigint, which would crash JSON.stringify undealt with.
    const huge = "9223372036854775807";
    runReplQuery(db, `INSERT INTO t (id, name) VALUES (${huge}, 'big')`);
    const result = runReplQuery(db, "SELECT id FROM t WHERE name = 'big'");
    expect(result.rows).toEqual([[huge]]);
    expect(typeof result.rows[0]?.[0]).toBe("string");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
