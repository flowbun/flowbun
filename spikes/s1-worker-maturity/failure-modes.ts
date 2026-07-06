// failure-modes.ts
//
// (a) Worker throws an uncaught error: does parent's 'error' event fire
//     reliably, and does the worker die or keep running afterward?
// (b) Worker enters an infinite busy loop: can the parent terminate() it
//     and have it actually stop within a few seconds? Hard-capped at 5s so
//     this test can never hang the suite. We verify "actually stopped" two
//     ways: (i) the parent process stays responsive and can spawn/use a new
//     worker right away, and (ii) direct CPU-tick evidence from
//     /proc/<pid>/task/<tid>/stat showing the specific spinning thread's
//     ticks freeze (stop increasing) once terminate() is called.

const url = new URL("./worker-echo.ts", import.meta.url).href;

function waitForReady(w: Worker): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if ((e.data as any)?.type === "ready") {
        w.removeEventListener("message", onMsg as any);
        resolve();
      }
    };
    w.addEventListener("message", onMsg as any);
  });
}

async function testThrow() {
  console.log("\n--- (a) uncaught error in worker ---");
  const w = new Worker(url);
  await waitForReady(w);

  const errorEvent = await new Promise<{ fired: boolean; message?: string }>((resolve) => {
    const timeout = setTimeout(() => resolve({ fired: false }), 3000);
    w.addEventListener("error", (e: any) => {
      clearTimeout(timeout);
      resolve({ fired: true, message: e?.message ?? String(e) });
    });
    w.postMessage({ type: "throw", at: Date.now(), payload: "boom" });
  });

  const errorLine = errorEvent.message?.split("\n").find((l) => l.trim().startsWith("error:")) ?? errorEvent.message;
  console.log(
    errorEvent.fired
      ? `[PASS] 'error' event fired on parent: ${errorLine}`
      : `[FAIL] 'error' event did NOT fire within 3s`
  );
  // Note: in Bun, ErrorEvent.error is null (unlike browsers where it carries
  // the actual Error object) and .message is a pretty-printed source-frame
  // dump rather than a plain error message string. Documented here since a
  // real Flowbun host would need to parse this rather than rely on .error.

  // Does the worker survive the uncaught error, or is it dead?
  const stillAlive = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    const onMsg = (e: MessageEvent) => {
      if ((e.data as any)?.type === "pong") {
        clearTimeout(timeout);
        w.removeEventListener("message", onMsg as any);
        resolve(true);
      }
    };
    w.addEventListener("message", onMsg as any);
    w.postMessage({ type: "ping", at: Date.now(), payload: "still there?" });
  });

  console.log(
    stillAlive
      ? `[INFO] worker is STILL RUNNING after the uncaught error (did not crash/exit)`
      : `[INFO] worker did NOT respond to a follow-up message after the uncaught error (thread/event loop appears dead)`
  );

  w.terminate();
}

// ---- CPU-tick helper for verifying terminate() actually stops a spin loop ----

async function readThreadTicks(): Promise<Map<string, number>> {
  const pid = process.pid;
  const taskDir = `/proc/${pid}/task`;
  const map = new Map<string, number>();
  const tids = (await Bun.$`ls ${taskDir}`.text()).split("\n").filter(Boolean);
  for (const tid of tids) {
    try {
      const stat = await Bun.$`cat ${taskDir}/${tid}/stat`.text();
      const closeParen = stat.lastIndexOf(")");
      const rest = stat.slice(closeParen + 2).split(" ");
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      map.set(tid, utime + stime);
    } catch {
      // thread exited between ls and cat; ignore
    }
  }
  return map;
}

async function testInfiniteLoopTerminate() {
  console.log("\n--- (b) infinite loop + terminate() ---");

  const beforeSpin = await readThreadTicks();
  const w = new Worker(url);
  await waitForReady(w);

  w.postMessage({ type: "spin", at: Date.now(), payload: null });
  await new Promise((r) => setTimeout(r, 300)); // let it actually enter the busy loop

  const duringSpin = await readThreadTicks();
  // Identify the spin thread: a thread that's new (or newly busy) since
  // before we started the worker, with a meaningfully large tick count.
  let spinTid = "";
  let spinTicks = -1;
  for (const [tid, ticks] of duringSpin) {
    const before = beforeSpin.get(tid) ?? 0;
    const delta = ticks - before;
    if (delta > spinTicks) {
      spinTicks = delta;
      spinTid = tid;
    }
  }
  console.log(`identified likely spin thread: tid ${spinTid} (accrued ${spinTicks} CPU ticks in 300ms of spinning)`);

  const start = performance.now();
  w.terminate();
  console.log(`terminate() call returned synchronously after ${(performance.now() - start).toFixed(2)}ms (its type signature is void, not a Promise)`);

  // Practical proxy #1: parent stays responsive enough to spawn+use a fresh
  // worker, hard-capped at 5s.
  const HARD_CAP_MS = 5000;
  const proxyWorker = new Worker(url);
  const proxyResult = await Promise.race([
    waitForReady(proxyWorker).then(() => "new-worker-ready" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), HARD_CAP_MS)),
  ]);
  const elapsedForProxy = performance.now() - start;
  proxyWorker.terminate();
  console.log(
    proxyResult === "new-worker-ready"
      ? `[PASS] parent process remained responsive; spawned+used a new worker ${elapsedForProxy.toFixed(0)}ms after terminate() was called`
      : `[FAIL] parent did not get a ready new worker within ${HARD_CAP_MS}ms hard cap`
  );

  // Practical proxy #2: does the specific spin thread's CPU tick count
  // actually freeze (stop increasing) after terminate(), across several
  // consecutive sampling windows? If it kept incrementing, the loop would
  // still be running on a leaked OS thread even though the parent moved on.
  let prev = await readThreadTicks();
  let stillTicking = false;
  const windowResults: string[] = [];
  for (let i = 1; i <= 4; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = await readThreadTicks();
    const spinDelta = (cur.get(spinTid) ?? 0) - (prev.get(spinTid) ?? 0);
    windowResults.push(`window ${i} (+${i * 500}ms): spin-thread delta = ${spinDelta}`);
    if (spinDelta > 0) stillTicking = true;
    prev = cur;
  }
  console.log(windowResults.join("\n"));
  console.log(
    stillTicking
      ? `[FAIL] the identified spin thread (tid ${spinTid}) kept accruing CPU after terminate() -- loop may not have actually stopped`
      : `[PASS] the identified spin thread (tid ${spinTid}) accrued ZERO further CPU ticks in the 2s after terminate() -- the busy loop actually stopped`
  );
}

async function main() {
  await testThrow();
  await testInfiniteLoopTerminate();
  process.exit(0);
}

main();
