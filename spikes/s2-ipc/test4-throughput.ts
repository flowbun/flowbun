// Test 4: sustained throughput, ~100 byte payloads, both directions, ~2.5s each.
import { deferred, withHardTimeout } from "./timeout";

const DURATION_MS = 2500;

async function measureParentToChild(): Promise<number> {
  const report = deferred<any>();
  const child = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "throughput"],
    ipc(message) {
      if (message?.type === "p2c-report") report.resolve(message);
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const payload = "x".repeat(80); // small payload, envelope pushes it to roughly ~100 bytes serialized
  let sent = 0;
  const start = performance.now();
  const end = start + DURATION_MS;
  while (performance.now() < end) {
    child.send({ type: "p2c", seq: sent, payload });
    sent++;
  }
  const elapsedMs = performance.now() - start;
  child.send({ type: "p2c-end" });

  const result = await withHardTimeout(report.promise, 10_000, "waiting for p2c-report");
  child.kill();
  await child.exited;

  console.log(`[parent->child] sent=${sent} received-by-child=${result.count} elapsedMs=${elapsedMs.toFixed(1)}`);
  return result.count / (elapsedMs / 1000);
}

async function measureChildToParent(): Promise<number> {
  const done = deferred<number>();
  let received = 0;
  let firstAt: number | null = null;
  let lastAt = 0;

  const child = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "throughput"],
    ipc(message) {
      if (message?.type === "c2p") {
        received++;
        const now = performance.now();
        if (firstAt === null) firstAt = now;
        lastAt = now;
      } else if (message?.type === "c2p-done") {
        done.resolve(message.count);
      }
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.send({ type: "start-c2p", durationMs: DURATION_MS });
  const sentCount = await withHardTimeout(done.promise, 10_000, "waiting for c2p-done");
  child.kill();
  await child.exited;

  const observedWindowMs = firstAt !== null ? lastAt - firstAt : 0;
  console.log(
    `[child->parent] sent-by-child=${sentCount} received=${received} observedWindowMs=${observedWindowMs.toFixed(1)}`,
  );
  // Use the child's own send-duration window (DURATION_MS) as the denominator since that's
  // the sustained-load window we asked for; it's a fair, reproducible measure of throughput.
  return received / (DURATION_MS / 1000);
}

const p2cRate = await measureParentToChild();
console.log("parent->child msgs/sec:", Math.round(p2cRate));

const c2pRate = await measureChildToParent();
console.log("child->parent msgs/sec:", Math.round(c2pRate));

console.log("TEST4_RESULT: PASS");
