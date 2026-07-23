import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowHostToWorker, WorkerToFlowHost } from "flowbun/ipc";

/**
 * Exercises the real worker-entry.ts inside a real Bun Worker — the
 * subscribe()/emit()/unsubscribe lifecycle worker-manager.ts relies on
 * (see its own doc comment on setRouter()) is genuinely worker-scoped
 * (postMessage/addEventListener globals), so a fake in-process double
 * wouldn't actually prove the wiring works. Uses a small fake block with a
 * `subscribe` hook instead of the real @hass/trigger, so this needs no HA
 * credentials at all.
 */

const FAKE_SUBSCRIBE_BLOCK = `
import { defineBlock } from "flowbun";
let unsubscribeCalled = false;
export default defineBlock({
  name: "@test/fake-source",
  kind: "source",
  config: {},
  inputs: {},
  outputs: { changed: {} },
  async subscribe(ctx, emit) {
    const timer = setTimeout(() => emit("changed", { hello: "world" }), 10);
    return () => {
      unsubscribeCalled = true;
      clearTimeout(timer);
      // Surface it via a log message so the test can observe it without
      // reaching into worker-internal state from outside the Worker.
      postMessage({ type: "log", level: "info", msg: "unsubscribed", meta: {} });
    };
  },
});
`;

// A duplex block's whole contract (see block.ts's DuplexBlockDef doc
// comment) is that subscribe() and process() run in the same module
// instance, so process() can answer into something subscribe() opened —
// modeled here by a module-level variable instead of a real socket.
const FAKE_DUPLEX_BLOCK = `
import { defineBlock } from "flowbun";
let opened = "";
export default defineBlock({
  name: "@test/fake-duplex",
  kind: "duplex",
  config: {},
  inputs: { reply: {} },
  outputs: { request: {} },
  async subscribe(ctx, emit) {
    opened = "endpoint-handle";
    setTimeout(() => emit("request", { requestId: "r1" }), 10);
    return () => {};
  },
  async process(inputs) {
    return { request: { sawHandle: opened, echoed: inputs.reply } };
  },
});
`;

// Proves the real Worker installs setExposedEntitiesTransport (worker-entry.ts)
// and that a block calling listExposedEntities() gets relayed out as a
// "hass.exposedEntities" postMessage and resolves once this test (standing
// in for worker-manager.ts) replies with "hass.exposedEntities.result" —
// the same round-trip shape as the existing hass.read/hass.call relays.
const FAKE_EXPOSED_ENTITIES_BLOCK = `
import { defineBlock } from "flowbun";
import { listExposedEntities } from "flowbun/hass/exposed-entities";
export default defineBlock({
  name: "@test/fake-exposed-entities",
  config: {},
  inputs: { go: {} },
  outputs: { entities: {} },
  async process() {
    const entities = await listExposedEntities("conversation");
    return { entities };
  },
});
`;

let dir: string;
let worker: Worker;

beforeEach(() => {
  // Inside the package (not the OS tmpdir): the fake block imports
  // `defineBlock` from "flowbun", a bare workspace-package specifier that
  // only resolves under this project's own node_modules — a file outside
  // it (e.g. os.tmpdir()) can't resolve that import at all.
  dir = mkdtempSync(join(import.meta.dir, ".worker-entry-test-"));
  writeFileSync(join(dir, "fake-source.ts"), FAKE_SUBSCRIBE_BLOCK);
  writeFileSync(join(dir, "fake-duplex.ts"), FAKE_DUPLEX_BLOCK);
  writeFileSync(
    join(dir, "fake-exposed-entities.ts"),
    FAKE_EXPOSED_ENTITIES_BLOCK,
  );
});

afterEach(() => {
  worker?.terminate();
  rmSync(dir, { recursive: true, force: true });
});

function waitForMessage(
  w: Worker,
  predicate: (msg: WorkerToFlowHost) => boolean,
  timeoutMs = 2000,
): Promise<WorkerToFlowHost> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for message")),
      timeoutMs,
    );
    const onMsg = (e: MessageEvent<WorkerToFlowHost>) => {
      if (predicate(e.data)) {
        clearTimeout(timer);
        w.removeEventListener("message", onMsg);
        resolve(e.data);
      }
    };
    w.addEventListener("message", onMsg);
  });
}

describe("worker-entry.ts subscribe lifecycle", () => {
  test("calls subscribe() at init and posts an 'event' message when the block emits", async () => {
    worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href);
    const ready = waitForMessage(worker, (m) => m.type === "ready");

    const initMsg: FlowHostToWorker = {
      type: "init",
      nodeId: "n1",
      flowName: "test-flow",
      blockModulePath: join(dir, "fake-source.ts"),
      config: {},
      dbPath: join(dir, "state.sqlite"),
    };
    worker.postMessage(initMsg);
    await ready;

    const event = await waitForMessage(worker, (m) => m.type === "event");
    expect(event).toEqual({
      type: "event",
      port: "changed",
      payload: { hello: "world" },
    });
  });

  test("calls the returned unsubscribe function on terminate", async () => {
    worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href);
    const ready = waitForMessage(worker, (m) => m.type === "ready");

    const initMsg: FlowHostToWorker = {
      type: "init",
      nodeId: "n1",
      flowName: "test-flow",
      blockModulePath: join(dir, "fake-source.ts"),
      config: {},
      dbPath: join(dir, "state2.sqlite"),
    };
    worker.postMessage(initMsg);
    await ready;

    const unsubscribed = waitForMessage(
      worker,
      (m) => m.type === "log" && m.msg === "unsubscribed",
    );
    worker.postMessage({ type: "terminate" } satisfies FlowHostToWorker);
    await expect(unsubscribed).resolves.toBeTruthy();
  });

  test("a duplex block gets subscribe() at init AND process() on exec, sharing module state", async () => {
    worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href);
    const ready = waitForMessage(worker, (m) => m.type === "ready");

    const initMsg: FlowHostToWorker = {
      type: "init",
      nodeId: "n1",
      flowName: "test-flow",
      blockModulePath: join(dir, "fake-duplex.ts"),
      config: {},
      dbPath: join(dir, "state3.sqlite"),
    };
    worker.postMessage(initMsg);
    await ready;

    // subscribe() ran and its emit surfaces as an unsolicited "event".
    const event = await waitForMessage(worker, (m) => m.type === "event");
    expect(event).toEqual({
      type: "event",
      port: "request",
      payload: { requestId: "r1" },
    });

    // process() runs via ordinary exec delivery — and sees the module-level
    // handle subscribe() opened, which is the whole point of the kind.
    const result = waitForMessage(worker, (m) => m.type === "result");
    const execMsg: FlowHostToWorker = {
      type: "exec",
      requestId: 1,
      inputs: { reply: { requestId: "r1" } },
      port: "reply",
      traceId: "t1",
      seq: 1,
    };
    worker.postMessage(execMsg);
    expect(await result).toEqual({
      type: "result",
      requestId: 1,
      outputs: {
        request: {
          sawHandle: "endpoint-handle",
          echoed: { requestId: "r1" },
        },
      },
    });
  });

  test("listExposedEntities() relays through hass.exposedEntities and resolves with the flow-host's reply", async () => {
    worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href);
    const ready = waitForMessage(worker, (m) => m.type === "ready");

    worker.postMessage({
      type: "init",
      nodeId: "n1",
      flowName: "test-flow",
      blockModulePath: join(dir, "fake-exposed-entities.ts"),
      config: {},
      dbPath: join(dir, "state4.sqlite"),
    } satisfies FlowHostToWorker);
    await ready;

    const relayed = waitForMessage(
      worker,
      (m) => m.type === "hass.exposedEntities",
    );
    const resultPromise = waitForMessage(worker, (m) => m.type === "result");

    worker.postMessage({
      type: "exec",
      requestId: 1,
      inputs: { go: {} },
      port: "go",
      traceId: "t1",
      seq: 1,
    } satisfies FlowHostToWorker);

    const request = await relayed;
    if (request.type !== "hass.exposedEntities") throw new Error("unreached");
    expect(request.assistant).toBe("conversation");

    worker.postMessage({
      type: "hass.exposedEntities.result",
      requestId: request.requestId,
      entities: [
        {
          entity: "light.living_room",
          domain: "light",
          friendlyName: "Living Room",
          aliases: [],
          areaId: null,
        },
      ],
    } satisfies FlowHostToWorker);

    expect(await resultPromise).toEqual({
      type: "result",
      requestId: 1,
      outputs: {
        entities: [
          {
            entity: "light.living_room",
            domain: "light",
            friendlyName: "Living Room",
            aliases: [],
            areaId: null,
          },
        ],
      },
    });
  });
});
