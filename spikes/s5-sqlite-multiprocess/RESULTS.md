# S5: SQLite across processes

## Question
Can multiple OS processes safely open and concurrently write to the same `bun:sqlite` WAL-mode database file, or do we need a single owning process + IPC?

## Method
5 real OS processes (spawned via `Bun.spawn`, not Worker threads — see `worker.ts`), all opening the same `test.db` file with `PRAGMA journal_mode = WAL`. Each process ran a tight loop for 8 seconds doing `UPDATE counters SET value = value + 1 WHERE id = ?` against 3 shared rows (`c0`/`c1`/`c2`, round-robined) wrapped in explicit `BEGIN IMMEDIATE` / `COMMIT` (rolling back on error) to maximize write-lock contention. Ran two phases back-to-back with a fresh db each time: (1) no `busy_timeout` set, (2) `PRAGMA busy_timeout = 5000` set on every connection. Each worker tracked attempted/succeeded/busy/other-error counts per phase, written to a per-worker JSON result file (`run-test.ts` orchestrates, `verify.ts` checks integrity + row sums afterward).

## Results
- SQLITE_BUSY observed without busy_timeout: **yes, overwhelming majority of attempts**. 8,620,063 attempted transactions across 5 workers, only 20,162 succeeded, 8,599,901 failed with `SQLITE_BUSY: database is locked` (99.77% busy rate). Zero non-busy errors. This confirms the contention setup is real, not a no-op.
- Behavior with busy_timeout set (5000ms): errors nearly eliminated. 28,823 attempted, 28,820 succeeded, only **3** SQLITE_BUSY errors total across all 5 workers (0.01% of attempts) despite the same 5-way contention on the same 3 rows. SQLite's internal busy-handler retry loop absorbed almost all lock contention transparently.
- integrity_check after run: **ok** (both phases).
- Expected vs actual final values: **match** in both phases.
  - No busy_timeout: sum of counter rows = 20,162; sum of workers' reported successful writes = 20,162.
  - With busy_timeout: sum of counter rows = 28,820; sum of workers' reported successful writes = 28,820.
  - Per-counter (c0/c1/c2 individually) sums also matched exactly in both phases — no silent lost writes, no double-counting, no corruption.
- Throughput under contention with busy_timeout set: **~3,540 writes/sec** across all 5 processes combined (28,820 successful writes / 8.15s wall time). Without busy_timeout, "successful" throughput was ~2,510 writes/sec, but that's misleading — it reflects mostly-failed attempts (writes silently fail unless the app retries), not usable throughput.

## Verdict
PASS (multi-process WAL access is safe at our scale)

## Notes
- **WAL/SHM files**: confirmed present (`test.db-wal`, `test.db-shm`) while workers were actively running (checked mid-run via `existsSync` after a short sleep, not just after exit) — direct evidence WAL mode was genuinely active during the contention window. A separate isolated single-worker check showed the `-wal` file growing to several MB during a run and then disappearing after the last connection to the db closed cleanly (SQLite auto-checkpoints and removes `-wal`/`-shm` on last-connection-close). Initially our driver checked for these files only *after* all processes had exited, which wrongly reported `false` — fixed to check mid-run instead. This is a good reminder that WAL/SHM presence checks (and any external tooling that inspects the db file) need to account for this auto-checkpoint-on-close behavior.
- **No corruption, no lost writes, no hangs** were observed in any run. `BEGIN IMMEDIATE` + `busy_timeout` is sufficient to make concurrent multi-process writers behave correctly — SQLite's own locking/retry semantics handle the rest.
- **Caveat on realism of the workload**: our contention pattern (5 processes issuing near-back-to-back single-row UPDATEs on only 3 shared rows, no other work between transactions) is much more adversarial than Flowbun's actual per-block/per-flow/global state writes are likely to be (those will be interleaved with real flow execution work, not a tight loop). So ~3,500 writes/sec under contention should be read as a conservative floor, not a realistic ceiling — real-world throughput with less pathological contention would likely be higher.
- **Caveat on busy_timeout choice**: 5000ms is generous; it means a writer could in theory block for up to 5s before giving up. We did not tune this down to find a lower safe bound — for production use we'd want to pick a timeout that fails fast enough for the coordinator to notice and retry/backoff at the application layer, while still being long enough to absorb normal contention (3/28,823 busy errors here suggests even a much shorter timeout, e.g. 500ms-1000ms, would likely be fine at this contention level, but that wasn't directly tested).
- Reused the same 3 counter rows across all workers specifically to maximize contention (worst case). A real Flowbun workload with separate per-flow/per-block rows would have dramatically less contention than this stress test.
