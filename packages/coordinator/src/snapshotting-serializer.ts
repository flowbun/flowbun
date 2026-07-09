import type { GitSnapshotter } from "./git-snapshot";

export type Serializer = <T>(
  fn: () => Promise<T>,
  label?: string,
) => Promise<T>;

/**
 * Wraps an existing reload serializer (see serialize-reload.ts) so every
 * operation that passes through it also takes a git snapshot once it
 * settles — success or failure, since a write that fails typecheck still
 * changed what's on disk (see reloadWiringFileInner's own "always reflect
 * what's actually on disk now" comment in main.ts).
 *
 * Deliberately NOT baked into serialize-reload.ts itself: that file is a
 * pure, generic, already-well-tested concurrency primitive with zero
 * knowledge of files or git — coupling it to a specific side effect here
 * would force its own tests to know about the filesystem. Instead this
 * wraps it once, at the single point serializeReload is constructed in
 * main.ts, so every one of the ~9 call sites that already flow through the
 * three reload functions inherits snapshotting automatically — including
 * any future call site (e.g. an agent-editing feature reusing the same
 * typecheck-gated write path) without needing to remember to wire it up.
 *
 * Piggybacking the snapshot on the *same* total-order queue that already
 * serializes reloads also means at most one `git` operation ever runs at a
 * time, for free — avoids two concurrent `git commit`s racing on
 * `.git/index.lock`.
 */
export function createSnapshottingSerializer(
  base: Serializer,
  snapshotter: GitSnapshotter,
): Serializer {
  return function serializeReload<T>(
    fn: () => Promise<T>,
    label?: string,
  ): Promise<T> {
    return base(async () => {
      try {
        return await fn();
      } finally {
        await snapshotter.snapshot(label ?? "flowbun: automatic snapshot");
      }
    });
  };
}
