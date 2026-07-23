import { describe, expect, test } from "bun:test";
import type { AnyBlockDef, Logger, StateScope } from "../block";
import type { NodeExecutionRequest, NodeExecutor } from "./executor";
import { Router } from "./router";
import type { LoadedFlow, LoadedNode } from "./types";

function fakeStateScope(): StateScope {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function fakeBlock(name: string): AnyBlockDef {
  return {
    name,
    config: {},
    inputs: {},
    outputs: {},
    async process() {
      return undefined;
    },
  };
}

function fakeNode(nodeId: string, blockName = nodeId): LoadedNode {
  return {
    nodeId,
    block: fakeBlock(blockName),
    blockSpecifier: blockName,
    blockModulePath: blockName,
    config: {},
    blockState: fakeStateScope(),
    disabled: false,
  };
}

/** Builds a flow from a node-id list and a plain "src.port -> dst.port"
 * wire list, matching the shape assembleFlow() itself produces. */
function fakeFlow(
  nodeIds: string[],
  wires: Array<[string, string]> = [],
  overrides: Partial<Record<string, Partial<LoadedNode>>> = {},
): LoadedFlow {
  const nodes = new Map<string, LoadedNode>();
  for (const id of nodeIds) {
    nodes.set(id, { ...fakeNode(id), ...overrides[id] });
  }
  const wireIndex = new Map<string, Array<{ nodeId: string; port: string }>>();
  for (const [from, to] of wires) {
    const [srcNode, srcPort] = from.split(".") as [string, string];
    const [dstNode, dstPort] = to.split(".") as [string, string];
    const key = `${srcNode}.${srcPort}`;
    const list = wireIndex.get(key) ?? [];
    list.push({ nodeId: dstNode, port: dstPort });
    wireIndex.set(key, list);
  }
  return {
    name: "test",
    nodes,
    wireIndex,
    flowState: fakeStateScope(),
    globalState: fakeStateScope(),
  };
}

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A NodeExecutor whose behavior per node is fully scriptable, and which
 * records concurrency: how many calls to each node were in flight
 * simultaneously (peak), and the order calls started/finished in. */
class TrackingExecutor implements NodeExecutor {
  calls: Array<{ nodeId: string; at: number }> = [];
  starts: string[] = [];
  finishes: string[] = [];
  private active = new Map<string, number>();
  peakConcurrency = new Map<string, number>();
  peakGlobalConcurrency = 0;
  private globalActive = 0;

  constructor(
    private readonly behavior: (
      req: NodeExecutionRequest,
    ) => Promise<Record<string, unknown> | undefined>,
  ) {}

  async execute(
    req: NodeExecutionRequest,
  ): Promise<Record<string, unknown> | undefined> {
    this.calls.push({ nodeId: req.nodeId, at: Date.now() });
    this.starts.push(req.nodeId);
    const current = (this.active.get(req.nodeId) ?? 0) + 1;
    this.active.set(req.nodeId, current);
    this.peakConcurrency.set(
      req.nodeId,
      Math.max(this.peakConcurrency.get(req.nodeId) ?? 0, current),
    );
    this.globalActive++;
    this.peakGlobalConcurrency = Math.max(
      this.peakGlobalConcurrency,
      this.globalActive,
    );
    try {
      return await this.behavior(req);
    } finally {
      this.active.set(req.nodeId, (this.active.get(req.nodeId) ?? 1) - 1);
      this.globalActive--;
      this.finishes.push(req.nodeId);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Router basic delivery", () => {
  test("ingress delivers to the target node and returns a traceId", async () => {
    const executor = new TrackingExecutor(async () => undefined);
    const router = new Router(fakeFlow(["a"]), silentLog, executor);
    const traceId = router.ingress("a", "in", { hello: "world" });
    expect(typeof traceId).toBe("string");
    await router.waitForIdle();
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.nodeId).toBe("a");
  });

  test("a chain a -> b -> c delivers in causal order", async () => {
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "a") return { out: "from-a" };
      if (req.nodeId === "b") return { out: "from-b" };
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["a", "b", "c"],
        [
          ["a.out", "b.in"],
          ["b.out", "c.in"],
        ],
      ),
      silentLog,
      executor,
    );
    router.ingress("a", "in", {});
    await router.waitForIdle();
    expect(executor.starts).toEqual(["a", "b", "c"]);
  });

  test("an unknown node id warns and does not throw", async () => {
    const warnings: unknown[] = [];
    const log: Logger = {
      ...silentLog,
      warn: (msg, meta) => warnings.push({ msg, meta }),
    };
    const executor = new TrackingExecutor(async () => undefined);
    const router = new Router(fakeFlow(["a"]), log, executor);
    router.ingress("does-not-exist", "in", {});
    await router.waitForIdle();
    expect(executor.calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test("a disabled node is never executed", async () => {
    const executor = new TrackingExecutor(async () => undefined);
    const flow = fakeFlow(["a"], [], { a: { disabled: true } });
    const router = new Router(flow, silentLog, executor);
    router.ingress("a", "in", {});
    await router.waitForIdle();
    expect(executor.calls).toHaveLength(0);
  });

  test("a block that throws is isolated — logged, doesn't crash the router, no fan-out happens", async () => {
    const errors: unknown[] = [];
    const log: Logger = {
      ...silentLog,
      error: (msg, meta) => errors.push({ msg, meta }),
    };
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "a") throw new Error("boom");
      return undefined;
    });
    const router = new Router(
      fakeFlow(["a", "b"], [["a.out", "b.in"]]),
      log,
      executor,
    );
    router.ingress("a", "in", {});
    await router.waitForIdle();
    expect(executor.starts).toEqual(["a"]);
    expect(errors).toHaveLength(1);
  });

  test("a block returning undefined for an output port does not fan out on that port", async () => {
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "a") return { out1: "value", out2: undefined };
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["a", "b", "c"],
        [
          ["a.out1", "b.in"],
          ["a.out2", "c.in"],
        ],
      ),
      silentLog,
      executor,
    );
    router.ingress("a", "in", {});
    await router.waitForIdle();
    expect(executor.starts.sort()).toEqual(["a", "b"]);
  });
});

describe("Router concurrency: siblings run in parallel, same node stays serial", () => {
  test("a fan-out to two different nodes runs them concurrently, not back-to-back", async () => {
    const DELAY_MS = 80;
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "source") return { out: "go" };
      await delay(DELAY_MS);
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["source", "b", "c"],
        [
          ["source.out", "b.in"],
          ["source.out", "c.in"],
        ],
      ),
      silentLog,
      executor,
    );
    const start = Date.now();
    router.ingress("source", "in", {});
    await router.waitForIdle();
    const elapsed = Date.now() - start;

    // Sequential would take ~2*DELAY_MS; concurrent should be close to one
    // DELAY_MS. Generous upper bound to avoid CI flakiness while still
    // clearly distinguishing "ran in parallel" from "ran back-to-back".
    expect(elapsed).toBeLessThan(DELAY_MS * 1.6);
    expect(executor.peakConcurrency.get("b")).toBe(1);
    expect(executor.peakConcurrency.get("c")).toBe(1);
    expect(executor.peakGlobalConcurrency).toBeGreaterThanOrEqual(2);
  });

  test("multiple deliveries to the SAME node never run concurrently, even when two independent sources target it at once", async () => {
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "shared") {
        await delay(30);
      }
      return undefined;
    });
    const router = new Router(fakeFlow(["shared"]), silentLog, executor);
    // Two independent ingress calls landing back-to-back, both targeting
    // the same node — simulates two different upstream triggers firing at
    // once, not a single fan-out.
    router.ingress("shared", "in", { from: 1 });
    router.ingress("shared", "in", { from: 2 });
    await router.waitForIdle();

    expect(executor.calls).toHaveLength(2);
    expect(executor.peakConcurrency.get("shared")).toBe(1);
  });

  test("one slow sibling does not block delivery to the other — the fast one finishes first", async () => {
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "source") return { out: "go" };
      if (req.nodeId === "slow") await delay(100);
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["source", "slow", "fast"],
        [
          ["source.out", "slow.in"],
          ["source.out", "fast.in"],
        ],
      ),
      silentLog,
      executor,
    );
    router.ingress("source", "in", {});
    await router.waitForIdle();
    // "fast" (no artificial delay) must finish before "slow" (100ms delay) —
    // only possible if they actually ran concurrently rather than in
    // enqueue order.
    const slowFinish = executor.finishes.indexOf("slow");
    const fastFinish = executor.finishes.indexOf("fast");
    expect(fastFinish).toBeLessThan(slowFinish);
  });

  test("waitForIdle waits out the full transitive cascade, including grandchildren spawned mid-wait", async () => {
    // a -> b (30ms delay) -> c (30ms delay) -> d. waitForIdle must not
    // resolve until d has actually run, even though b's own drain (which
    // waitForIdle first observes) resolves well before c/d even start.
    const executor = new TrackingExecutor(async (req) => {
      if (req.nodeId === "a") return { out: "1" };
      if (req.nodeId === "b") {
        await delay(30);
        return { out: "2" };
      }
      if (req.nodeId === "c") {
        await delay(30);
        return { out: "3" };
      }
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["a", "b", "c", "d"],
        [
          ["a.out", "b.in"],
          ["b.out", "c.in"],
          ["c.out", "d.in"],
        ],
      ),
      silentLog,
      executor,
    );
    router.ingress("a", "in", {});
    await router.waitForIdle();
    expect(executor.starts).toEqual(["a", "b", "c", "d"]);
  });

  test("many concurrent independent chains all complete and waitForIdle covers all of them", async () => {
    const executor = new TrackingExecutor(async (req) => {
      await delay(Math.random() * 20);
      if (req.nodeId.startsWith("src")) return { out: req.nodeId };
      return undefined;
    });
    const nodeIds = Array.from({ length: 10 }, (_, i) => `src${i}`).concat(
      Array.from({ length: 10 }, (_, i) => `dst${i}`),
    );
    const wires: Array<[string, string]> = Array.from(
      { length: 10 },
      (_, i) => [`src${i}.out`, `dst${i}.in`],
    );
    const router = new Router(fakeFlow(nodeIds, wires), silentLog, executor);
    for (let i = 0; i < 10; i++) router.ingress(`src${i}`, "in", {});
    await router.waitForIdle();
    expect(executor.calls).toHaveLength(20);
  });
});

describe("Router emitFromSource", () => {
  test("fans out to wired destinations and logs router.produced without calling the source's own process()", async () => {
    const logs: string[] = [];
    const log: Logger = { ...silentLog, info: (msg) => logs.push(msg) };
    const executor = new TrackingExecutor(async () => undefined);
    const router = new Router(
      fakeFlow(["trigger", "b"], [["trigger.changed", "b.in"]]),
      log,
      executor,
    );
    router.emitFromSource("trigger", "changed", { state: "on" });
    await router.waitForIdle();
    expect(executor.starts).toEqual(["b"]);
    expect(logs).toContain("router.produced");
  });

  test("two destinations of an emitFromSource fan-out run concurrently", async () => {
    const executor = new TrackingExecutor(async () => {
      await delay(60);
      return undefined;
    });
    const router = new Router(
      fakeFlow(
        ["trigger", "b", "c"],
        [
          ["trigger.changed", "b.in"],
          ["trigger.changed", "c.in"],
        ],
      ),
      silentLog,
      executor,
    );
    const start = Date.now();
    router.emitFromSource("trigger", "changed", {});
    await router.waitForIdle();
    expect(Date.now() - start).toBeLessThan(60 * 1.6);
  });
});
