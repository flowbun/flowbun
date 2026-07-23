import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedFlow, LoadedNode, Logger, Router } from "flowbun";
import { WorkerManager } from "./worker-manager";

const FAKE_SUBSCRIBE_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "@test/fake-source",
  kind: "source",
  config: {},
  inputs: {},
  outputs: { changed: {} },
  async subscribe(ctx, emit) {
    const timer = setTimeout(() => emit("changed", { hello: "world" }), 10);
    return () => clearTimeout(timer);
  },
});
`;

// Closes its own worker thread (Bun's Worker equivalent of a Web Worker's
// self.close()) shortly after subscribing -- a silent exit that never fires
// an "error" event, exercising the same gap a real process.exit()/OOM kill
// would. The marker file makes the *first* import (during startAll's initial
// spawn) succeed, and every import after that (i.e. every respawn's re-init)
// throw -- simulating a respawn whose init() permanently fails, which should
// converge to dead:true (and one onNodeDead call) rather than getting stuck
// answering "worker not initialized" forever.
function flakyRespawnBlockSource(markerPath: string): string {
  return `
import { defineBlock } from "flowbun";
import { existsSync, writeFileSync } from "node:fs";

const marker = ${JSON.stringify(markerPath)};
if (existsSync(marker)) {
  throw new Error("simulated respawn init failure");
}
writeFileSync(marker, "1");

export default defineBlock({
  name: "@test/flaky-respawn",
  kind: "source",
  config: {},
  inputs: {},
  outputs: {},
  async subscribe() {
    setTimeout(() => { close(); }, 10);
    return () => {};
  },
});
`;
}

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SLOW_TRANSFORM_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "@test/slow-transform",
  config: {},
  inputs: { go: {} },
  outputs: { done: {} },
  async process() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { done: {} };
  },
});
`;

function fakeTransformNode(blockModulePath: string): LoadedNode {
  return {
    nodeId: "n1",
    block: {
      name: "@test/slow-transform",
      config: {},
      inputs: { go: {} },
      outputs: { done: {} },
      // Only needsWorker()'s presence check reads this in-memory stub — the
      // real process() that actually runs lives in the on-disk block file
      // at blockModulePath, imported fresh inside the Worker (same pattern
      // as fakeNode's own subscribe stub above).
      async process() {
        return undefined;
      },
    },
    blockSpecifier: "slow-transform",
    blockModulePath,
    config: {},
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    blockState: {} as any,
    disabled: false,
  };
}

function fakeNode(blockModulePath: string): LoadedNode {
  return {
    nodeId: "n1",
    block: {
      name: "@test/fake-source",
      kind: "source",
      config: {},
      inputs: {},
      outputs: {},
      // Only needsWorker()'s presence check reads this in-memory stub — the
      // real subscribe() that actually runs lives in the on-disk block file
      // at blockModulePath, imported fresh inside the Worker. Without this,
      // needsWorker() (correctly) reads "no subscribe" and skips spawning a
      // Worker at all, same as it now does for @core/inject.
      subscribe: async () => () => {},
    },
    blockSpecifier: "fake-source",
    blockModulePath,
    config: {},
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    blockState: {} as any,
    disabled: false,
  };
}

function fakeFlow(node: LoadedNode): LoadedFlow {
  return {
    name: "test",
    nodes: new Map([[node.nodeId, node]]),
    wireIndex: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    flowState: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    globalState: {} as any,
  };
}

let dir: string;
let manager: WorkerManager | undefined;

beforeEach(() => {
  // See worker-entry.test.ts's own comment: must be inside the package,
  // not os.tmpdir(), for the fake block's "flowbun" import to resolve.
  dir = mkdtempSync(join(import.meta.dir, ".worker-manager-test-"));
  writeFileSync(join(dir, "fake-source.ts"), FAKE_SUBSCRIBE_BLOCK);
  mkdirSync(join(dir, "state"), { recursive: true });
});

afterEach(async () => {
  await manager?.stopAll();
  manager = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkerManager event routing", () => {
  test("an 'event' message from a subscribing block's Worker is routed to router.emitFromSource with the node's own id", async () => {
    const node = fakeNode(join(dir, "fake-source.ts"));
    const flow = fakeFlow(node);
    manager = new WorkerManager(flow, dir, noopLog);

    const emitted: Array<[string, string, unknown]> = [];
    const fakeRouter = {
      emitFromSource: (nodeId: string, port: string, payload: unknown) => {
        emitted.push([nodeId, port, payload]);
        return "trace-id";
      },
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    } as any as Router;
    manager.setRouter(fakeRouter);

    await manager.startAll();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for emitFromSource")),
        2000,
      );
      const check = setInterval(() => {
        if (emitted.length > 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(emitted).toEqual([["n1", "changed", { hello: "world" }]]);
  });
});

describe("WorkerManager respawn / death reporting", () => {
  test("a worker that exits without an 'error' event is detected, and a respawn whose init() keeps failing converges to dead with exactly one onNodeDead call", async () => {
    const markerPath = join(dir, ".spawned-once");
    writeFileSync(
      join(dir, "flaky-respawn.ts"),
      flakyRespawnBlockSource(markerPath),
    );
    const node = fakeNode(join(dir, "flaky-respawn.ts"));
    const flow = fakeFlow(node);
    const deadNodes: string[] = [];
    manager = new WorkerManager(flow, dir, noopLog, (nodeId) =>
      deadNodes.push(nodeId),
    );
    const fakeRouter = {
      emitFromSource: () => "trace-id",
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    } as any as Router;
    manager.setRouter(fakeRouter);

    await manager.startAll();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for onNodeDead")),
        8000,
      );
      const check = setInterval(() => {
        if (deadNodes.length > 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Exactly one death report -- the close/error dedup (handledDeath) and
    // the dead:true short-circuit in handleDeath must both hold, or this
    // would fire more than once as the doomed worker's stale events land.
    expect(deadNodes).toEqual(["n1"]);

    // Give any further stray events a moment to land, then confirm nothing
    // else arrived after the first (and only expected) death report.
    await new Promise((r) => setTimeout(r, 200));
    expect(deadNodes).toEqual(["n1"]);
  });
});

describe("WorkerManager exec timeout override", () => {
  test("a per-call timeoutMs actually governs when exec() gives up, independent of the module's own default", async () => {
    writeFileSync(join(dir, "slow-transform.ts"), SLOW_TRANSFORM_BLOCK);
    const node = fakeTransformNode(join(dir, "slow-transform.ts"));
    const flow = fakeFlow(node);
    manager = new WorkerManager(flow, dir, noopLog);
    await manager.startAll();

    const requestId = manager.allocRequestId();
    const start = Date.now();
    // The block itself takes 300ms — a 50ms override must reject well
    // before that, proving req.timeoutMs (not the 10s module default) is
    // what's actually governing the timer.
    await expect(
      manager.exec(node.nodeId, requestId, {
        inputs: { go: {} },
        port: "go",
        traceId: "t1",
        seq: 1,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/worker exec timeout/);
    expect(Date.now() - start).toBeLessThan(250);
  });
});
