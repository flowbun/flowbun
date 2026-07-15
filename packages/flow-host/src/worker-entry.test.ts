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
  config: {},
  inputs: {},
  outputs: { changed: {} },
  async process() { return undefined; },
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

let dir: string;
let worker: Worker;

beforeEach(() => {
  // Inside the package (not the OS tmpdir): the fake block imports
  // `defineBlock` from "flowbun", a bare workspace-package specifier that
  // only resolves under this project's own node_modules — a file outside
  // it (e.g. os.tmpdir()) can't resolve that import at all.
  dir = mkdtempSync(join(import.meta.dir, ".worker-entry-test-"));
  writeFileSync(join(dir, "fake-source.ts"), FAKE_SUBSCRIBE_BLOCK);
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
});
