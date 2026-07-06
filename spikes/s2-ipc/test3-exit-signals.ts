// Test 3: exit signal reliability for supervision.
//  (a) clean exit: child calls process.exit(0)
//  (b) killed: parent calls subprocess.kill() (SIGTERM) and separately subprocess.kill("SIGKILL")
import { deferred, withHardTimeout } from "./timeout";

async function runCleanExit() {
  const exitInfo = deferred<{ code: number | null; signal: string | null }>();
  const child = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "exit-clean"],
    ipc(_message) {
      // just observing; the "exiting" message should arrive before exit
    },
    stdio: ["ignore", "inherit", "inherit"],
    onExit(_subprocess, exitCode, signalCode) {
      exitInfo.resolve({ code: exitCode, signal: signalCode });
    },
  });

  child.send({ type: "please-exit-clean" });

  const result = await withHardTimeout(exitInfo.promise, 10_000, "waiting for clean exit");
  const exited = await withHardTimeout(child.exited, 10_000, "waiting for child.exited (clean)");
  console.log("[clean exit] onExit callback:", result);
  console.log("[clean exit] child.exited resolved with code:", exited);
  console.log("[clean exit] child.exitCode:", child.exitCode, "child.signalCode:", child.signalCode);
  return result.code === 0 && result.signal === null && exited === 0;
}

async function runKilledSigterm() {
  const exitInfo = deferred<{ code: number | null; signal: string | null }>();
  const child = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "idle-until-killed"],
    ipc(_message) {},
    stdio: ["ignore", "inherit", "inherit"],
    onExit(_subprocess, exitCode, signalCode) {
      exitInfo.resolve({ code: exitCode, signal: signalCode });
    },
  });

  // Make sure IPC is actually alive before we kill it.
  const pingReply = deferred<any>();
  const child2 = child; // just for clarity
  child2.send({ type: "ping" });
  await Bun.sleep(100); // small grace period; we aren't strictly checking the pong here

  child.kill(); // default SIGTERM
  const result = await withHardTimeout(exitInfo.promise, 10_000, "waiting for SIGTERM exit");
  console.log("[killed SIGTERM] onExit callback:", result);
  console.log("[killed SIGTERM] child.exitCode:", child.exitCode, "child.signalCode:", child.signalCode);
  return result.signal === "SIGTERM";
}

async function runKilledSigkill() {
  const exitInfo = deferred<{ code: number | null; signal: string | null }>();
  const child = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "idle-until-killed"],
    ipc(_message) {},
    stdio: ["ignore", "inherit", "inherit"],
    onExit(_subprocess, exitCode, signalCode) {
      exitInfo.resolve({ code: exitCode, signal: signalCode });
    },
  });

  await Bun.sleep(100);
  child.kill("SIGKILL");
  const result = await withHardTimeout(exitInfo.promise, 10_000, "waiting for SIGKILL exit");
  console.log("[killed SIGKILL] onExit callback:", result);
  console.log("[killed SIGKILL] child.exitCode:", child.exitCode, "child.signalCode:", child.signalCode);
  return result.signal === "SIGKILL";
}

const cleanOk = await runCleanExit();
const sigtermOk = await runKilledSigterm();
const sigkillOk = await runKilledSigkill();

console.log("clean exit ok:", cleanOk);
console.log("SIGTERM kill ok:", sigtermOk);
console.log("SIGKILL kill ok:", sigkillOk);

const pass = cleanOk && sigtermOk && sigkillOk;
console.log("TEST3_RESULT:", pass ? "PASS" : "FAIL");
