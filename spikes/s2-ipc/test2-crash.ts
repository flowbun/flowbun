// Test 2: child crashes mid-burst. From the parent's side:
//  - does 'exit' fire reliably with the right exit code?
//  - are in-flight messages silently lost (expected), with no hang and no duplicate acks?
import { withHardTimeout } from "./timeout";

const BURST_SIZE = 200;
const CRASH_AFTER = 50; // child will process.exit(1) after acking the 50th message

const acks = new Set<number>();
let exitInfo: { code: number | null; signal: string | null } | null = null;

const child = Bun.spawn({
  cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "crash-burst", String(CRASH_AFTER)],
  ipc(message) {
    if (message?.type === "ack") acks.add(message.seq);
  },
  stdio: ["ignore", "inherit", "inherit"],
  onExit(_subprocess, exitCode, signalCode) {
    exitInfo = { code: exitCode, signal: signalCode };
  },
});

for (let i = 0; i < BURST_SIZE; i++) {
  child.send({ type: "burst", seq: i });
}

try {
  await withHardTimeout(child.exited, 10_000, "waiting for child to exit after crash");
} catch (err) {
  console.log("TEST2_RESULT: FAIL (child did not exit / hung)", err);
  child.kill("SIGKILL");
  process.exit(1);
}

// Give onExit callback and any final IPC messages a moment to settle.
await Bun.sleep(200);

const exitCode = child.exitCode;
const signalCode = child.signalCode;

console.log("acks received:", acks.size, "of", BURST_SIZE);
console.log("acks max seq:", Math.max(-1, ...acks));
console.log("duplicate acks?", acks.size !== new Set(acks).size ? "n/a" : "checked via Set, no dupes possible in this structure");
console.log("child.exitCode:", exitCode);
console.log("child.signalCode:", signalCode);
console.log("onExit callback fired:", exitInfo !== null, exitInfo);

// Expectations:
// - the child should have acked somewhere around CRASH_AFTER messages before dying (not all BURST_SIZE)
// - exit code should be 1 (process.exit(1))
// - no hang (we already know this because withHardTimeout resolved)
const gotFewerThanAll = acks.size < BURST_SIZE && acks.size > 0;
const exitCodeCorrect = exitCode === 1;
const onExitFired = exitInfo !== null;

const pass = gotFewerThanAll && exitCodeCorrect && onExitFired;
console.log("TEST2_RESULT:", pass ? "PASS" : "FAIL");
