// leak-loop.ts
//
// Spawn -> send a few messages -> terminate(), repeated ~300 times.
// Samples parent RSS every ~20 iterations to see whether memory trends
// upward (leak) or plateaus after warmup (expected/healthy).

const ITERATIONS = 300;
const SAMPLE_EVERY = 20;
const MESSAGES_PER_WORKER = 3;
const SETTLE_MS = Number(process.argv[2] ?? 0);

function rssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

async function runOneWorkerCycle(url: string): Promise<void> {
  const w = new Worker(url);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("worker did not become ready in time")), 3000);
    const onReady = (e: MessageEvent) => {
      if ((e.data as any)?.type === "ready") {
        clearTimeout(timeout);
        w.removeEventListener("message", onReady as any);
        resolve();
      }
    };
    w.addEventListener("message", onReady as any);
  });

  for (let m = 0; m < MESSAGES_PER_WORKER; m++) {
    await new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if ((e.data as any)?.type === "pong") {
          w.removeEventListener("message", onMsg as any);
          resolve();
        }
      };
      w.addEventListener("message", onMsg as any);
      w.postMessage({ type: "ping", at: Date.now(), payload: { i: m } });
    });
  }

  w.terminate();
  // Bun's Worker.terminate() returns void (not a Promise, unlike Node's
  // worker_threads) -- it does not tell us when the underlying OS thread has
  // actually finished tearing down. SETTLE_MS lets us test whether giving
  // teardown more wall-clock time between cycles changes the RSS trend
  // (distinguishing "threads piling up faster than they're reaped" from a
  // true per-cycle leak).
  if (SETTLE_MS > 0) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
}

async function main() {
  const url = new URL("./worker-echo.ts", import.meta.url).href;
  const samples: { iter: number; rss: number }[] = [];

  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 100));
  samples.push({ iter: 0, rss: rssMB() });
  console.log(`iter 0: RSS ${samples[0].rss.toFixed(2)} MB (baseline)`);

  for (let i = 1; i <= ITERATIONS; i++) {
    await runOneWorkerCycle(url);

    if (i % SAMPLE_EVERY === 0 || i === ITERATIONS) {
      Bun.gc(true);
      await new Promise((r) => setTimeout(r, 20));
      const rss = rssMB();
      samples.push({ iter: i, rss });
      console.log(`iter ${i}: RSS ${rss.toFixed(2)} MB`);
    }
  }

  // Simple trend check: compare average of first 3 post-warmup samples vs
  // average of last 3 samples.
  const postWarmup = samples.filter((s) => s.iter >= SAMPLE_EVERY * 2); // skip first couple samples (warmup)
  const firstHalf = postWarmup.slice(0, 3);
  const lastHalf = postWarmup.slice(-3);
  const avg = (arr: typeof samples) => arr.reduce((s, x) => s + x.rss, 0) / arr.length;
  const firstAvg = avg(firstHalf);
  const lastAvg = avg(lastHalf);
  const growth = lastAvg - firstAvg;
  const growthPct = (growth / firstAvg) * 100;

  console.log(`\n=== summary ===`);
  console.log(`first post-warmup avg RSS (iters ${firstHalf.map((s) => s.iter).join(",")}): ${firstAvg.toFixed(2)} MB`);
  console.log(`last avg RSS (iters ${lastHalf.map((s) => s.iter).join(",")}): ${lastAvg.toFixed(2)} MB`);
  console.log(`growth: ${growth.toFixed(2)} MB (${growthPct.toFixed(1)}%)`);
  console.log(
    growthPct > 20
      ? "VERDICT: RSS trended upward noticeably -- possible leak, investigate further"
      : "VERDICT: RSS roughly plateaued after warmup -- no strong leak signal in this run"
  );

  process.exit(0);
}

main();
