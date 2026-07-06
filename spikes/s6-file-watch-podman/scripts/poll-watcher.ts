// S6 spike: fallback mtime-polling watcher, in case fs.watch proves unreliable on
// bind mounts under Podman. Stats every file in /data on an interval and diffs
// against the previous snapshot to detect create/modify/delete. Logs to
// /data/poll-log.txt (on the bind mount) and stdout.
//
// Note: a rename is reported as delete(old-name) + create(new-name) since plain
// mtime/dirent polling can't distinguish a rename from delete+create without
// inode tracking. That's expected and still proves the change was detected.

import fs from "fs";
import path from "path";

const dir = "/data";
const logPath = path.join(dir, "poll-log.txt");
const durationMs = parseInt(process.env.WATCH_DURATION_MS || "8000", 10);
const intervalMs = parseInt(process.env.POLL_INTERVAL_MS || "500", 10);

function log(line: string) {
  const msg = `${new Date().toISOString()} ${line}`;
  console.log(msg);
  fs.appendFileSync(logPath, msg + "\n");
}

fs.writeFileSync(logPath, "");
log(`POLLER_START pid=${process.pid} watching=${dir} interval=${intervalMs}ms`);

const IGNORE = new Set(["poll-log.txt", "fswatch-log.txt"]);

function snapshot(): Map<string, number> {
  const current = new Map<string, number>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log(`SNAPSHOT_ERROR ${String(err)}`);
    return current;
  }
  for (const name of entries) {
    if (IGNORE.has(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      current.set(name, st.mtimeMs);
    } catch {
      // file disappeared between readdir and stat; treat as absent
    }
  }
  return current;
}

let known = snapshot();
log(`POLLER_READY initial=${JSON.stringify([...known.keys()])}`);

const timer = setInterval(() => {
  const current = snapshot();

  for (const [name, mtime] of current) {
    if (!known.has(name)) {
      log(`POLL_EVENT type=create filename=${name}`);
    } else if (known.get(name) !== mtime) {
      log(`POLL_EVENT type=modify filename=${name}`);
    }
  }
  for (const name of known.keys()) {
    if (!current.has(name)) {
      log(`POLL_EVENT type=delete filename=${name}`);
    }
  }
  known = current;
}, intervalMs);

setTimeout(() => {
  clearInterval(timer);
  log("POLLER_DONE");
  process.exit(0);
}, durationMs);
