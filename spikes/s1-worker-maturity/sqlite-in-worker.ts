// sqlite-in-worker.ts
//
// Host script: spawns a worker that uses bun:sqlite (see sqlite-worker.ts),
// waits (with a hard timeout so a crash/hang can't stall the suite) for it
// to report results, and prints pass/fail per step. Also checks that the
// parent process is still alive/responsive afterward (i.e. a worker-side
// sqlite crash, if any, didn't take down the whole process).

const url = new URL("./sqlite-worker.ts", import.meta.url).href;

async function main() {
  const w = new Worker(url);
  let crashed = false;

  w.addEventListener("error", (e: any) => {
    crashed = true;
    console.log(`[INFO] worker 'error' event fired: ${String(e?.message).split("\n").pop()}`);
  });

  const HARD_CAP_MS = 5000;
  const resultsPayload = await Promise.race([
    new Promise<any[] | null>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        const data = e.data as any;
        if (data?.type === "sqlite-results") {
          w.removeEventListener("message", onMsg as any);
          resolve(data.payload);
        }
      };
      w.addEventListener("message", onMsg as any);
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HARD_CAP_MS)),
  ]);

  w.terminate();

  console.log("=== bun:sqlite-in-worker results ===");
  if (resultsPayload === null) {
    console.log(`[FAIL] worker did not report results within ${HARD_CAP_MS}ms (crashed=${crashed}) -- process likely still alive though, see below`);
  } else {
    let allOk = true;
    for (const r of resultsPayload) {
      console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.step}: ${r.detail}`);
      if (!r.ok) allOk = false;
    }
    console.log(`\nOverall: ${allOk ? "PASS" : "FAIL"}`);
  }

  // Prove the parent process itself is still fine (didn't crash even if
  // sqlite-in-worker had problems) by doing one more trivial worker round trip.
  const echoUrl = new URL("./worker-echo.ts", import.meta.url).href;
  const echoWorker = new Worker(echoUrl);
  const parentStillFine = await Promise.race([
    new Promise<boolean>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if ((e.data as any)?.type === "ready") {
          echoWorker.removeEventListener("message", onMsg as any);
          resolve(true);
        }
      };
      echoWorker.addEventListener("message", onMsg as any);
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  echoWorker.terminate();
  console.log(`\n[INFO] parent process remained usable after the sqlite-in-worker test: ${parentStillFine}`);

  process.exit(0);
}

main();
