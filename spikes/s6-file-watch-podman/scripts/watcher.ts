// S6 spike: does fs.watch on a bind-mounted dir see host-side changes from inside
// a Podman container? Logs every fs.watch event with a timestamp to /data/fswatch-log.txt
// (which lives on the bind mount so the host can read it after the container exits),
// and also to stdout (captured via `podman logs`).
//
// Also does a quick reverse check: writes a file from inside the container into the
// bind mount, so the driver script can confirm the host sees it appear.

import fs from "fs";
import path from "path";

const dir = "/data";
const logPath = path.join(dir, "fswatch-log.txt");
const durationMs = parseInt(process.env.WATCH_DURATION_MS || "8000", 10);

function log(line: string) {
  const msg = `${new Date().toISOString()} ${line}`;
  console.log(msg);
  fs.appendFileSync(logPath, msg + "\n");
}

// Fresh log file for this run.
fs.writeFileSync(logPath, "");

const bunVersion = (globalThis as any).Bun?.version ?? "not-bun";
log(`WATCHER_START pid=${process.pid} bun=${bunVersion} watching=${dir}`);

let watcher: fs.FSWatcher | undefined;
try {
  watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
    log(`EVENT type=${eventType} filename=${filename}`);
  });
  log("WATCHER_READY");
} catch (err) {
  log(`WATCHER_ERROR ${String(err)}`);
}

// Reverse check: container -> host visibility.
setTimeout(() => {
  try {
    fs.writeFileSync(
      path.join(dir, "container-wrote-this.txt"),
      `written by container at ${new Date().toISOString()}\n`
    );
    log("CONTAINER_WROTE_FILE container-wrote-this.txt");
  } catch (err) {
    log(`CONTAINER_WRITE_ERROR ${String(err)}`);
  }
}, 500);

setTimeout(() => {
  log("WATCHER_DONE");
  try {
    watcher?.close();
  } catch {}
  process.exit(0);
}, durationMs);
