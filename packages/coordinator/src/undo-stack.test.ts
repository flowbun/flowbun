import { describe, expect, test } from "bun:test";
import { UndoStack } from "./undo-stack";

describe("UndoStack", () => {
  test("status starts with nothing to undo or redo", () => {
    const stack = new UndoStack();
    expect(stack.status("a.json")).toEqual({ canUndo: false, canRedo: false });
  });

  test("undo restores the previous text and enables redo", () => {
    const stack = new UndoStack();
    stack.beforeMutate("a.json", "v1");
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });

    const restored = stack.undo("a.json", "v2");
    expect(restored).toBe("v1");
    expect(stack.status("a.json")).toEqual({ canUndo: false, canRedo: true });
  });

  test("redo restores what undo just reverted", () => {
    const stack = new UndoStack();
    stack.beforeMutate("a.json", "v1");
    stack.undo("a.json", "v2");

    const restored = stack.redo("a.json", "v1");
    expect(restored).toBe("v2");
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("undo with nothing to undo returns undefined", () => {
    const stack = new UndoStack();
    expect(stack.undo("a.json", "v1")).toBeUndefined();
  });

  test("redo with nothing to redo returns undefined", () => {
    const stack = new UndoStack();
    expect(stack.redo("a.json", "v1")).toBeUndefined();
  });

  test("a new mutation clears redo history", () => {
    const stack = new UndoStack();
    stack.beforeMutate("a.json", "v1");
    stack.undo("a.json", "v2");
    expect(stack.status("a.json").canRedo).toBe(true);

    stack.beforeMutate("a.json", "v1"); // a fresh edit after undoing
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("multiple undos walk back through history in order", () => {
    const stack = new UndoStack();
    stack.beforeMutate("a.json", "v1");
    stack.beforeMutate("a.json", "v2");
    stack.beforeMutate("a.json", "v3");

    expect(stack.undo("a.json", "v4")).toBe("v3");
    expect(stack.undo("a.json", "v3")).toBe("v2");
    expect(stack.undo("a.json", "v2")).toBe("v1");
    expect(stack.undo("a.json", "v1")).toBeUndefined();
  });

  test("histories are independent per file", () => {
    const stack = new UndoStack();
    stack.beforeMutate("a.json", "a-v1");
    expect(stack.status("b.json")).toEqual({ canUndo: false, canRedo: false });
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("history is bounded — the oldest entry is evicted past capacity", () => {
    const stack = new UndoStack();
    // MAX_HISTORY is 50 (see undo-stack.ts); push 51 distinct snapshots.
    for (let i = 0; i < 51; i++) stack.beforeMutate("a.json", `v${i}`);
    // Undo 50 times should exhaust every retained snapshot down to v1
    // (v0 was evicted as the oldest) and then have nothing left.
    let last: string | undefined;
    for (let i = 0; i < 50; i++) last = stack.undo("a.json", `after-${i}`);
    expect(last).toBe("v1");
    expect(stack.undo("a.json", "after-50")).toBeUndefined();
  });
});
