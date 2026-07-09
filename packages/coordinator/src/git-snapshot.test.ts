import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitSnapshotter } from "./git-snapshot";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-git-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createGitSnapshotter", () => {
  test("first snapshot() inits the repo and commits a new file", async () => {
    const snapshotter = createGitSnapshotter(dir);
    writeFileSync(join(dir, "a.ts"), "1");

    const result = await snapshotter.snapshot("add a.ts");
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.hash).toBeTruthy();
  });

  test("a second snapshot() with no changes commits nothing", async () => {
    const snapshotter = createGitSnapshotter(dir);
    writeFileSync(join(dir, "a.ts"), "1");
    await snapshotter.snapshot("add a.ts");

    const second = await snapshotter.snapshot("nothing changed");
    expect(second.ok).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.hash).toBeUndefined();

    const history = await snapshotter.history();
    expect(history).toHaveLength(1);
  });

  test("three snapshots across add/modify/delete each produce their own commit", async () => {
    const snapshotter = createGitSnapshotter(dir);

    writeFileSync(join(dir, "a.ts"), "1");
    const first = await snapshotter.snapshot("add a.ts");

    writeFileSync(join(dir, "a.ts"), "2");
    const second = await snapshotter.snapshot("modify a.ts");

    rmSync(join(dir, "a.ts"));
    const third = await snapshotter.snapshot("delete a.ts");

    expect([first, second, third].every((r) => r.committed)).toBe(true);
    const hashes = new Set([first.hash, second.hash, third.hash]);
    expect(hashes.size).toBe(3);

    const history = await snapshotter.history();
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.message)).toEqual([
      "delete a.ts",
      "modify a.ts",
      "add a.ts",
    ]);
  });

  test("history() scoped to a path only returns commits touching that path", async () => {
    const snapshotter = createGitSnapshotter(dir);
    writeFileSync(join(dir, "a.ts"), "1");
    await snapshotter.snapshot("add a.ts");
    writeFileSync(join(dir, "b.ts"), "1");
    await snapshotter.snapshot("add b.ts");
    writeFileSync(join(dir, "a.ts"), "2");
    await snapshotter.snapshot("modify a.ts");

    const aHistory = await snapshotter.history("a.ts");
    expect(aHistory.map((h) => h.message)).toEqual(["modify a.ts", "add a.ts"]);
  });

  test("readFileAt returns the exact historical content of a since-modified file", async () => {
    const snapshotter = createGitSnapshotter(dir);
    writeFileSync(join(dir, "a.ts"), "v1");
    const first = await snapshotter.snapshot("v1");
    writeFileSync(join(dir, "a.ts"), "v2");
    await snapshotter.snapshot("v2");

    expect(await snapshotter.readFileAt(first.hash as string, "a.ts")).toBe(
      "v1",
    );
  });

  test("readFileAt returns undefined for a path that didn't exist at that commit", async () => {
    const snapshotter = createGitSnapshotter(dir);
    writeFileSync(join(dir, "a.ts"), "v1");
    const first = await snapshotter.snapshot("v1");

    expect(
      await snapshotter.readFileAt(first.hash as string, "nope.ts"),
    ).toBeUndefined();
  });

  test("fails open when git isn't a real binary — nothing throws, everything degrades to no-op", async () => {
    const snapshotter = createGitSnapshotter(dir, "/definitely/not/a/real/git");
    writeFileSync(join(dir, "a.ts"), "1");

    const result = await snapshotter.snapshot("add a.ts");
    expect(result).toEqual({ ok: true, committed: false });
    expect(await snapshotter.history()).toEqual([]);
    expect(await snapshotter.readFileAt("deadbeef", "a.ts")).toBeUndefined();
  });
});
