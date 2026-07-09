import type { GitSnapshotter } from "./git-snapshot";

export interface UndoStatus {
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 50;

/**
 * Git-backed undo/redo, keyed by path relative to dataDir (works for both
 * wiring files and block files — block files never had undo/redo at all
 * before this). A file's *content* at any point is always recoverable via
 * git (see git-snapshot.ts), so nothing here duplicates raw text — but the
 * undo/redo *cursor* (which hash to jump to next) is deliberately kept as a
 * small in-memory hash stack, not derived by re-reading git log on every
 * call.
 *
 * Why not derive it purely from git log position: every undo/redo restore
 * is itself committed by the generic snapshotting hook (so it shows up in
 * history, auditable like any other change) — but that means after one
 * undo, the file's log is no longer in the same order as the *original*
 * edit sequence. E.g. edits v1→v2→v3→v4, then undo to v3 commits a new
 * entry whose *content* is v3 but which sits chronologically after v4.
 * Naively taking "the previous log entry" for the next undo would then
 * restore v4 — the state just undone away from — instead of continuing
 * backward to v2. An explicit stack of hashes, pushed on each genuine edit
 * and popped on undo, doesn't have this problem (this is exactly the
 * original in-memory UndoStack's algorithm — only the payload changed from
 * raw text to a hash, since content is always recoverable from git). Found
 * by writing the test for "multiple undos walk back through history in
 * order" and watching it restore the wrong state, not by inspection.
 *
 * Accepted tradeoff: unlike the underlying git history (which is fully
 * durable — see the History panel, backed directly by git-snapshot.ts),
 * this cursor is in-memory and does NOT survive a coordinator restart,
 * same as most editors' redo/undo not surviving an app restart. Nothing is
 * ever lost — a restart just clears the "quick undo N times" convenience
 * layer, not the ability to jump to any past commit via History.
 */
export class UndoStack {
  constructor(private readonly snapshotter: GitSnapshotter) {}

  private undoStacks = new Map<string, string[]>();
  private redoStacks = new Map<string, string[]>();

  status(file: string): UndoStatus {
    return {
      canUndo: (this.undoStacks.get(file)?.length ?? 0) > 0,
      canRedo: (this.redoStacks.get(file)?.length ?? 0) > 0,
    };
  }

  /** Call once a genuinely new edit (not itself an undo/redo) has already
   * been committed — i.e. after the write+reload(+auto-commit) has
   * settled, not before. Pushes the file's pre-edit HEAD onto the undo
   * stack (the second-newest history entry, now that the new edit is
   * HEAD) and clears any pending redo, same as a fresh edit always has. */
  async recordEdit(file: string): Promise<void> {
    this.redoStacks.delete(file);
    const [, previous] = await this.snapshotter.history(file, 2);
    if (!previous) return; // this was the file's first-ever commit
    const stack = this.undoStacks.get(file) ?? [];
    stack.push(previous.hash);
    if (stack.length > MAX_HISTORY) stack.shift();
    this.undoStacks.set(file, stack);
  }

  /** Returns the content to restore (caller writes it back through the
   * normal write+reload path, which produces a new forward commit — this
   * never does a destructive git reset). Undefined if there's nothing to
   * undo to. */
  async undo(file: string): Promise<string | undefined> {
    const stack = this.undoStacks.get(file);
    const targetHash = stack?.pop();
    if (!targetHash) return undefined;
    const content = await this.snapshotter.readFileAt(targetHash, file);
    if (content === undefined) return undefined;
    const [current] = await this.snapshotter.history(file, 1);
    if (current) {
      const redo = this.redoStacks.get(file) ?? [];
      redo.push(current.hash);
      this.redoStacks.set(file, redo);
    }
    return content;
  }

  /** Returns the content to restore, same caller contract as undo(). */
  async redo(file: string): Promise<string | undefined> {
    const redo = this.redoStacks.get(file);
    const targetHash = redo?.pop();
    if (!targetHash) return undefined;
    const content = await this.snapshotter.readFileAt(targetHash, file);
    if (content === undefined) return undefined;
    const [current] = await this.snapshotter.history(file, 1);
    if (current) {
      const stack = this.undoStacks.get(file) ?? [];
      stack.push(current.hash);
      this.undoStacks.set(file, stack);
    }
    return content;
  }

  /** Drops a file's undo/redo cursor entirely — call when its file is deleted. */
  forget(file: string): void {
    this.undoStacks.delete(file);
    this.redoStacks.delete(file);
  }
}
