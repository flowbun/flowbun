import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitSnapshotter, type GitSnapshotter } from "./git-snapshot";
import { UndoStack } from "./undo-stack";

let dir: string;
let snapshotter: GitSnapshotter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-undo-test-"));
  snapshotter = createGitSnapshotter(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Simulates a genuine user-initiated edit — write, auto-commit (as
 * snapshotting-serializer would after a successful write+reload), then
 * record it for undo purposes, exactly the sequence the real call sites
 * follow. */
async function edit(
  stack: UndoStack,
  file: string,
  content: string,
  label: string,
) {
  writeFileSync(join(dir, file), content);
  await snapshotter.snapshot(label);
  await stack.recordEdit(file);
}

/** Simulates the WS handler's side of an undo/redo: ask the stack what to
 * restore, write it back, and let it auto-commit — but deliberately does
 * NOT call recordEdit(), same as the real handlers never do. */
async function applyUndo(stack: UndoStack, file: string) {
  const content = await stack.undo(file);
  if (content !== undefined) {
    writeFileSync(join(dir, file), content);
    await snapshotter.snapshot(`undo: ${file}`);
  }
  return content;
}

async function applyRedo(stack: UndoStack, file: string) {
  const content = await stack.redo(file);
  if (content !== undefined) {
    writeFileSync(join(dir, file), content);
    await snapshotter.snapshot(`redo: ${file}`);
  }
  return content;
}

describe("UndoStack", () => {
  test("status starts with nothing to undo or redo", () => {
    const stack = new UndoStack(snapshotter);
    expect(stack.status("a.json")).toEqual({
      canUndo: false,
      canRedo: false,
    });
  });

  test("a single edit still has nothing to undo to", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    expect(stack.status("a.json")).toEqual({ canUndo: false, canRedo: false });
  });

  test("undo restores the previous content and enables redo", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });

    const restored = await applyUndo(stack, "a.json");
    expect(restored).toBe("v1");
    expect(stack.status("a.json")).toEqual({ canUndo: false, canRedo: true });
  });

  test("redo restores what undo just reverted", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    await applyUndo(stack, "a.json");

    const restored = await applyRedo(stack, "a.json");
    expect(restored).toBe("v2");
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("undo with nothing to undo returns undefined", async () => {
    const stack = new UndoStack(snapshotter);
    expect(await stack.undo("a.json")).toBeUndefined();
  });

  test("redo with nothing to redo returns undefined", async () => {
    const stack = new UndoStack(snapshotter);
    expect(await stack.redo("a.json")).toBeUndefined();
  });

  test("a new edit after undoing clears redo history", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    await applyUndo(stack, "a.json");
    expect(stack.status("a.json").canRedo).toBe(true);

    await edit(stack, "a.json", "v3", "v3"); // a fresh edit, not an undo/redo
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("multiple undos walk back through the real edit history in order, not ping-ponging off the undo commits themselves", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    await edit(stack, "a.json", "v3", "v3");
    await edit(stack, "a.json", "v4", "v4");

    expect(await applyUndo(stack, "a.json")).toBe("v3");
    expect(await applyUndo(stack, "a.json")).toBe("v2");
    expect(await applyUndo(stack, "a.json")).toBe("v1");
    expect(await applyUndo(stack, "a.json")).toBeUndefined();
  });

  test("undo then redo then undo again all resolve correctly", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    await edit(stack, "a.json", "v3", "v3");

    expect(await applyUndo(stack, "a.json")).toBe("v2");
    expect(await applyUndo(stack, "a.json")).toBe("v1");
    expect(await applyRedo(stack, "a.json")).toBe("v2");
    expect(await applyRedo(stack, "a.json")).toBe("v3");
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("histories are independent per file", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "a-v1", "a-v1");
    await edit(stack, "a.json", "a-v2", "a-v2");
    expect(stack.status("b.json")).toEqual({ canUndo: false, canRedo: false });
    expect(stack.status("a.json")).toEqual({ canUndo: true, canRedo: false });
  });

  test("forget drops a file's undo/redo cursor", async () => {
    const stack = new UndoStack(snapshotter);
    await edit(stack, "a.json", "v1", "v1");
    await edit(stack, "a.json", "v2", "v2");
    await applyUndo(stack, "a.json");
    expect(stack.status("a.json").canRedo).toBe(true);

    stack.forget("a.json");
    expect(stack.status("a.json")).toEqual({ canUndo: false, canRedo: false });
  });

  test("history is bounded — the oldest entry is evicted past capacity", async () => {
    const stack = new UndoStack(snapshotter);
    // MAX_HISTORY is 50 (see undo-stack.ts). The very first edit (v0) never
    // pushes anything — recordEdit() only pushes a *previous* state, and
    // there isn't one yet — so 52 edits (v0..v51) produce 51 pushes
    // (v0hash..v50hash), one over capacity, evicting the oldest (v0hash).
    for (let i = 0; i < 52; i++) {
      await edit(stack, "a.json", `v${i}`, `v${i}`);
    }
    // 50 undos should exhaust every retained entry down to v1 (v0's target
    // was evicted as the oldest) and then have nothing left.
    let last: string | undefined;
    for (let i = 0; i < 50; i++) last = await applyUndo(stack, "a.json");
    expect(last).toBe("v1");
    expect(await applyUndo(stack, "a.json")).toBeUndefined();
  });
});
