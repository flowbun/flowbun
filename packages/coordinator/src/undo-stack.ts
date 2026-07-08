const MAX_HISTORY = 50;

interface FileHistory {
  undo: string[];
  redo: string[];
}

/**
 * Per-file undo/redo history of raw wiring-file text snapshots. Scoped to
 * user-initiated wiring.mutate calls only — never externally-detected file
 * edits picked up by fs.watch — since "undo" here means "undo my last
 * change in the editor", not "revert whatever just changed on disk".
 * Bounded per file (ring-buffer style, like log-buffer.ts) so a long
 * editing session can't grow this unboundedly.
 */
export class UndoStack {
  private files = new Map<string, FileHistory>();

  private historyFor(file: string): FileHistory {
    let h = this.files.get(file);
    if (!h) {
      h = { undo: [], redo: [] };
      this.files.set(file, h);
    }
    return h;
  }

  /** Call with the file's text BEFORE applying a new user-initiated mutation. */
  beforeMutate(file: string, currentText: string): void {
    const h = this.historyFor(file);
    h.undo.push(currentText);
    if (h.undo.length > MAX_HISTORY) h.undo.shift();
    h.redo = []; // a fresh edit invalidates any redo history
  }

  /** Pops the last undo snapshot (if any), pushes currentText onto redo, and returns the text to restore. */
  undo(file: string, currentText: string): string | undefined {
    const h = this.historyFor(file);
    const previous = h.undo.pop();
    if (previous === undefined) return undefined;
    h.redo.push(currentText);
    if (h.redo.length > MAX_HISTORY) h.redo.shift();
    return previous;
  }

  /** Pops the last redo snapshot (if any), pushes currentText onto undo, and returns the text to restore. */
  redo(file: string, currentText: string): string | undefined {
    const h = this.historyFor(file);
    const next = h.redo.pop();
    if (next === undefined) return undefined;
    h.undo.push(currentText);
    if (h.undo.length > MAX_HISTORY) h.undo.shift();
    return next;
  }

  status(file: string): { canUndo: boolean; canRedo: boolean } {
    const h = this.files.get(file);
    return {
      canUndo: (h?.undo.length ?? 0) > 0,
      canRedo: (h?.redo.length ?? 0) > 0,
    };
  }
}
