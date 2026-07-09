import { describe, expect, test } from "bun:test";
import { createReloadSerializer } from "./serialize-reload";
import { createSnapshottingSerializer } from "./snapshotting-serializer";

/** A fake GitSnapshotter — these tests are pure and shouldn't touch a real
 * git repo, mirroring serialize-reload.test.ts's own abstract, fake-based
 * style. */
function fakeSnapshotter() {
  const calls: string[] = [];
  return {
    calls,
    snapshot: async (message: string) => {
      calls.push(message);
      return { ok: true, committed: true, hash: "deadbeef" };
    },
    history: async () => [],
    readFileAt: async () => undefined,
  };
}

describe("createSnapshottingSerializer", () => {
  test("snapshots exactly once per settled call, on success", async () => {
    const snapshotter = fakeSnapshotter();
    const serializeReload = createSnapshottingSerializer(
      createReloadSerializer(),
      snapshotter,
    );

    const result = await serializeReload(async () => "ok", "did a thing");
    expect(result).toBe("ok");
    expect(snapshotter.calls).toEqual(["did a thing"]);
  });

  test("snapshots exactly once per settled call, on rejection — and the caller still sees the real error", async () => {
    const snapshotter = fakeSnapshotter();
    const serializeReload = createSnapshottingSerializer(
      createReloadSerializer(),
      snapshotter,
    );

    await expect(
      serializeReload(async () => {
        throw new Error("boom");
      }, "failed thing"),
    ).rejects.toThrow("boom");
    expect(snapshotter.calls).toEqual(["failed thing"]);
  });

  test("falls back to a generic label when none is given", async () => {
    const snapshotter = fakeSnapshotter();
    const serializeReload = createSnapshottingSerializer(
      createReloadSerializer(),
      snapshotter,
    );

    await serializeReload(async () => "ok");
    expect(snapshotter.calls).toEqual(["flowbun: automatic snapshot"]);
  });

  test("snapshot calls happen in the same total order as the underlying queue", async () => {
    const snapshotter = fakeSnapshotter();
    const serializeReload = createSnapshottingSerializer(
      createReloadSerializer(),
      snapshotter,
    );

    const slow = serializeReload(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "slow";
    }, "slow");
    const fast = serializeReload(async () => "fast", "fast");

    expect(await Promise.all([slow, fast])).toEqual(["slow", "fast"]);
    expect(snapshotter.calls).toEqual(["slow", "fast"]);
  });
});
