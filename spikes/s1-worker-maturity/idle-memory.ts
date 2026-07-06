// idle-memory.ts
//
// Measures idle memory overhead of spawning 25 Bun Workers.
// Run twice, as two separate process invocations (so measurements don't
// contaminate each other via shared GC state / already-warmed heap):
//
//   bun run idle-memory.ts default
//   bun run idle-memory.ts smol
//
// Method: read baseline RSS before spawning anything, spawn all 25 workers
// with the given options, wait for each to post a "ready" message (proves
// the worker thread actually started and its JS runtime initialized), then
// read RSS again. Difference / 25 = approx incremental memory per worker.
//
// Caveat: Bun Workers are threads inside the same OS process (confirmed via
// /proc/<pid>/task listing during setup), so process.memoryUsage().rss in
// the parent already reflects all worker memory. There is no per-worker PID
// to inspect separately.

const mode = process.argv[2] === "smol" ? "smol" : "default";
const WORKER_COUNT = 25;

function rssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

async function gcSettle() {
  // Bun exposes Bun.gc(force) - use it to get a more stable reading.
  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 100));
}

async function main() {
  await gcSettle();
  const baseline = rssMB();
  console.log(`[${mode}] baseline RSS: ${baseline.toFixed(2)} MB`);

  const url = new URL("./worker-echo.ts", import.meta.url).href;
  const workers: Worker[] = [];
  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < WORKER_COUNT; i++) {
    const opts: WorkerOptions = mode === "smol" ? { smol: true } : {};
    const w = new Worker(url, opts);
    workers.push(w);
    readyPromises.push(
      new Promise<void>((resolve) => {
        const onMsg = (e: MessageEvent) => {
          if ((e.data as any)?.type === "ready") {
            w.removeEventListener("message", onMsg as any);
            resolve();
          }
        };
        w.addEventListener("message", onMsg as any);
      })
    );
  }

  await Promise.all(readyPromises);
  // Let things settle (GC, thread stack allocation, etc.)
  await new Promise((r) => setTimeout(r, 300));
  await gcSettle();

  const afterSpawn = rssMB();
  const totalDelta = afterSpawn - baseline;
  const perWorker = totalDelta / WORKER_COUNT;

  console.log(`[${mode}] RSS after ${WORKER_COUNT} idle workers: ${afterSpawn.toFixed(2)} MB`);
  console.log(`[${mode}] total incremental RSS: ${totalDelta.toFixed(2)} MB`);
  console.log(`[${mode}] approx per-worker incremental RSS: ${perWorker.toFixed(2)} MB`);

  for (const w of workers) w.terminate();
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

main();
