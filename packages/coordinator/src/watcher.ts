import { watch } from "node:fs";
import { join } from "node:path";

export type ReloadScope =
  | { kind: "blocks"; files: string[] }
  | { kind: "wiring"; file: string };

const DEBOUNCE_MS = 300;

/**
 * Debounced fs.watch on data/blocks/ and data/wiring/ — real fs.watch, not
 * mtime polling, since spike S6 proved it works reliably on this bare-metal
 * Podman/Fedora machine (the well-known "broken on bind mounts" caveat is
 * specific to Docker Desktop's VM-proxied filesystem, which doesn't apply
 * here).
 */
export function startWatcher(
  dataDir: string,
  onReload: (scope: ReloadScope) => void,
): () => void {
  let blocksTimer: ReturnType<typeof setTimeout> | null = null;
  // A single shared debounce window covers every file changed within it, so
  // "the file that changed" is a set, not one filename — otherwise editing
  // two blocks within DEBOUNCE_MS of each other would only report the last.
  const blocksTouched = new Set<string>();
  const wiringTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const blocksWatcher = watch(join(dataDir, "blocks"), (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    blocksTouched.add(join(dataDir, "blocks", filename));
    if (blocksTimer) clearTimeout(blocksTimer);
    blocksTimer = setTimeout(() => {
      const files = [...blocksTouched];
      blocksTouched.clear();
      onReload({ kind: "blocks", files });
    }, DEBOUNCE_MS);
  });

  const wiringWatcher = watch(join(dataDir, "wiring"), (_event, filename) => {
    if (!filename?.endsWith(".json")) return;
    const existing = wiringTimers.get(filename);
    if (existing) clearTimeout(existing);
    wiringTimers.set(
      filename,
      setTimeout(() => {
        wiringTimers.delete(filename);
        onReload({ kind: "wiring", file: join(dataDir, "wiring", filename) });
      }, DEBOUNCE_MS),
    );
  });

  return () => {
    blocksWatcher.close();
    wiringWatcher.close();
  };
}
