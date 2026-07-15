import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedFlow, LoadedNode, Logger, Router } from "flowbun";
import { WorkerManager } from "./worker-manager";

const FAKE_SUBSCRIBE_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "@test/fake-source",
  config: {},
  inputs: {},
  outputs: { changed: {} },
  async process() { return undefined; },
  async subscribe(ctx, emit) {
    const timer = setTimeout(() => emit("changed", { hello: "world" }), 10);
    return () => clearTimeout(timer);
  },
});
`;

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeNode(blockModulePath: string): LoadedNode {
  return {
    nodeId: "n1",
    block: {
      name: "@test/fake-source",
      config: {},
      inputs: {},
      outputs: {},
      process: async () => undefined,
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
