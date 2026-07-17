import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

export type ReloadScope =
  | { kind: "blocks"; files: string[] }
  | { kind: "wiring"; file: string };

const DEBOUNCE_MS = 300;
// fs.watch/inotify is the primary signal (near-instant) and stays on as
// the fast path, but has been observed in production to silently stop
// delivering events for host-side (bind-mount) edits after running a
// while — no error, no crash, the watcher object just goes quiet, taking
// auto-reload AND the git-snapshot history (which only fires on a
// completed reload — see snapshotting-serializer.ts) down with it. An
// earlier version of this file deliberately skipped mtime polling on the
// strength of one bare-metal Podman/Fedora spike; that doesn't generalize
// to every deployment (this one runs under Docker) and clearly isn't
// sufficient on its own — see the incident this comment was added for.
// Polling every few seconds is cheap at this file count (a handful of
// blocks/wiring files, one readdir + one stat each) and bounds the worst
// case: an edit is never missed for longer than one interval, regardless
// of whatever inotify is or isn't doing.
const POLL_INTERVAL_MS = 3000;

/**
 * Debounced fs.watch on data/blocks/ and data/wiring/, backstopped by mtime
 * polling (see POLL_INTERVAL_MS above) so a missed inotify event still gets
 * picked up.
 */
export function startWatcher(
  dataDir: string,
  onReload: (scope: ReloadScope) => void,
): () => void {
  const blocksDir = join(dataDir, "blocks");
  const wiringDir = join(dataDir, "wiring");

  let blocksTimer: ReturnType<typeof setTimeout> | null = null;
  // A single shared debounce window covers every file changed within it, so
  // "the file that changed" is a set, not one filename — otherwise editing
  // two blocks within DEBOUNCE_MS of each other would only report the last.
  const blocksTouched = new Set<string>();
  const wiringTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Factored out of the fs.watch callbacks so the polling backstop below
  // can feed the exact same debounce path — a change picked up by polling
  // instead of inotify still gets a debounce window and the same
  // downstream reload, not a second, divergent code path to keep in sync.
  const touchBlock = (filename: string) => {
    if (!filename.endsWith(".ts")) return;
    blocksTouched.add(join(blocksDir, filename));
    if (blocksTimer) clearTimeout(blocksTimer);
    blocksTimer = setTimeout(() => {
      const files = [...blocksTouched];
      blocksTouched.clear();
      onReload({ kind: "blocks", files });
    }, DEBOUNCE_MS);
  };
  const touchWiring = (filename: string) => {
    if (!filename.endsWith(".json")) return;
    const existing = wiringTimers.get(filename);
    if (existing) clearTimeout(existing);
    wiringTimers.set(
      filename,
      setTimeout(() => {
        wiringTimers.delete(filename);
        onReload({ kind: "wiring", file: join(wiringDir, filename) });
      }, DEBOUNCE_MS),
    );
  };

  const blocksWatcher = watch(blocksDir, (_event, filename) => {
    if (filename) touchBlock(filename);
  });
  const wiringWatcher = watch(wiringDir, (_event, filename) => {
    if (filename) touchWiring(filename);
  });

  // Seeded synchronously before the interval starts, so the first poll
  // tick compares against "what's on disk right now" rather than an empty
  // map — an empty map would make every existing file look newly changed
  // and fire a reload storm on every coordinator start.
  const blocksMtimes = seedMtimes(blocksDir, ".ts");
  const wiringMtimes = seedMtimes(wiringDir, ".json");

  const pollTimer = setInterval(() => {
    poll(blocksDir, ".ts", blocksMtimes, touchBlock);
    poll(wiringDir, ".json", wiringMtimes, touchWiring);
  }, POLL_INTERVAL_MS);

  return () => {
    blocksWatcher.close();
    wiringWatcher.close();
    clearInterval(pollTimer);
  };
}

function seedMtimes(dir: string, ext: string): Map<string, number> {
  const known = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return known; // dir doesn't exist yet -- the first poll tick will notice once it does
  }
  for (const filename of entries) {
    if (!filename.endsWith(ext)) continue;
    try {
      known.set(filename, statSync(join(dir, filename)).mtimeMs);
    } catch {
      // vanished between readdir and stat -- the first poll tick will settle it
    }
  }
  return known;
}

function poll(
  dir: string,
  ext: string,
  known: Map<string, number>,
  touch: (filename: string) => void,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir transiently unreadable -- try again next tick
  }
  const seen = new Set<string>();
  for (const filename of entries) {
    if (!filename.endsWith(ext)) continue;
    seen.add(filename);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, filename)).mtimeMs;
    } catch {
      continue; // vanished mid-poll -- the removal branch below (next tick) settles it
    }
    if (known.get(filename) !== mtimeMs) {
      known.set(filename, mtimeMs);
      touch(filename);
    }
  }
  for (const filename of known.keys()) {
    if (!seen.has(filename)) known.delete(filename);
  }
}
