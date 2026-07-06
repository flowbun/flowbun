// verify.ts
//
// Post-run verification helpers, used by run-test.ts after a phase's worker
// processes have all exited. Kept as a standalone module so verification
// logic is separate from orchestration/spawning logic.

import { Database } from "bun:sqlite";

export interface CounterRow {
  id: string;
  value: number;
}

export interface VerifyResult {
  integrityOk: boolean;
  integrityRaw: string;
  rows: CounterRow[];
  totalValue: number;
}

export function verifyDb(dbPath: string): VerifyResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrityRow = db.query("PRAGMA integrity_check;").get() as { integrity_check: string };
    const integrityRaw = integrityRow.integrity_check;
    const integrityOk = integrityRaw === "ok";

    const rows = db.query("SELECT id, value FROM counters ORDER BY id").all() as CounterRow[];
    const totalValue = rows.reduce((s, r) => s + r.value, 0);

    return { integrityOk, integrityRaw, rows, totalValue };
  } finally {
    db.close();
  }
}
