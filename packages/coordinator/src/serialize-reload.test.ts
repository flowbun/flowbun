import { describe, expect, test } from "bun:test";
import { createReloadSerializer } from "./serialize-reload";

describe("createReloadSerializer", () => {
  test("runs operations in submission order, never overlapping, even when an earlier one is slower", async () => {
    const serializeReload = createReloadSerializer();
    const events: string[] = [];

    function op(name: string, delayMs: number) {
      return serializeReload(async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delayMs));
        events.push(`${name}:end`);
        return name;
      });
    }

    // Submit a slow operation, then a fast one immediately after — without
    // serialization, the fast one would start (and finish) first.
    const slow = op("slow", 30);
    const fast = op("fast", 0);

    expect(await Promise.all([slow, fast])).toEqual(["slow", "fast"]);
    expect(events).toEqual([
      "slow:start",
      "slow:end",
      "fast:start",
      "fast:end",
    ]);
  });

  test("each call resolves to its own function's result, not a previous one's", async () => {
    const serializeReload = createReloadSerializer();
    expect(await serializeReload(async () => "first")).toBe("first");
    expect(await serializeReload(async () => "second")).toBe("second");
  });

  test("a rejection doesn't break the chain for subsequent calls", async () => {
    const serializeReload = createReloadSerializer();
    const events: string[] = [];

    const first = serializeReload(async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = serializeReload(async () => {
      events.push("second");
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });

  test("reproduces the exact coordinator race and proves it: a slow 'blocks reload' finishes before a 'wiring reload' submitted right after it starts", async () => {
    const serializeReload = createReloadSerializer();
    const registry = new Set<string>(); // stand-in for main.ts's shared `registry`

    function reloadBlocks() {
      return serializeReload(async () => {
        await new Promise((r) => setTimeout(r, 30)); // discoverBlocks() takes real time
        registry.add("state_cache"); // the new block becomes known only now
      });
    }
    function reloadWiring() {
      return serializeReload(async () => {
        // Without serialization, this can run before reloadBlocks()
        // finishes and observe an empty registry — reproducing
        // 'references unknown block "state_cache"'.
        if (!registry.has("state_cache")) {
          throw new Error('references unknown block "state_cache"');
        }
        return "assembled ok";
      });
    }

    const blocksReload = reloadBlocks();
    const wiringReload = reloadWiring(); // fired immediately after, like the real burst of file writes
    await blocksReload;
    expect(await wiringReload).toBe("assembled ok");
  });
});
