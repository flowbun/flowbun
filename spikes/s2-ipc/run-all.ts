// Runs all four S2 IPC tests sequentially, each in its own bun subprocess (so a
// crash/hang in one test can't take down the others), with a hard per-test timeout.
import { withHardTimeout } from "./timeout";

const tests = ["test1-roundtrip.ts", "test2-crash.ts", "test3-exit-signals.ts", "test4-throughput.ts"];

for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/${test}`],
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    const code = await withHardTimeout(proc.exited, 20_000, `${test} did not finish in time`);
    console.log(`--- ${test} exited with code ${code} ---`);
  } catch (err) {
    console.log(`--- ${test} TIMED OUT / hung:`, err, "---");
    proc.kill("SIGKILL");
  }
}
