import type { AnyBlockDef, BlockContext } from "flowbun";
import { blockScopeKey, makeStateScope, openStateDb } from "flowbun";
import { setHassCallTransport } from "flowbun/hass/action";
import type { EntityStateReading } from "flowbun/hass/client";
import { setHassReadTransport } from "flowbun/hass/client";
import type { FlowHostToWorker, WorkerToFlowHost } from "flowbun/ipc";

let blockDef: AnyBlockDef | undefined;
let stateBundle: BlockContext["state"] | undefined;
let initConfig: unknown;
let unsubscribe: (() => void) | undefined;

function post(msg: WorkerToFlowHost): void {
  postMessage(msg);
}

// This Worker has no Home Assistant connection of its own — the flow's one
// real connection lives in the flow-host's main thread (see
// hass/client.ts's setHassReadTransport doc comment). Every block loaded
// into this Worker (whether it's @hass/read/@hass/action themselves, or an
// ordinary block like battery_controller that calls readEntityState()/
// performHassAction() directly) gets relayed through these two, installed
// once here rather than per-block.
let nextHassRequestId = 1;
const pendingHassReads = new Map<
  number,
  { resolve: (r: EntityStateReading | undefined) => void }
>();
const pendingHassCalls = new Map<
  number,
  { resolve: () => void; reject: (e: Error) => void }
>();

setHassReadTransport({
  readEntity: (entity) =>
    new Promise((resolve) => {
      const requestId = nextHassRequestId++;
      pendingHassReads.set(requestId, { resolve });
      post({ type: "hass.read", requestId, entity });
    }),
});

setHassCallTransport({
  call: (call, dryRun) =>
    new Promise((resolve, reject) => {
      const requestId = nextHassRequestId++;
      pendingHassCalls.set(requestId, { resolve, reject });
      post({ type: "hass.call", requestId, call, dryRun });
    }),
});

const log = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    post({ type: "log", level: "debug", msg, meta }),
  info: (msg: string, meta?: Record<string, unknown>) =>
    post({ type: "log", level: "info", msg, meta }),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    post({ type: "log", level: "warn", msg, meta }),
  error: (msg: string, meta?: Record<string, unknown>) =>
    post({ type: "log", level: "error", msg, meta }),
};

addEventListener("message", async (event: MessageEvent<FlowHostToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      try {
        const mod = await import(msg.blockModulePath);
        blockDef = mod.default as AnyBlockDef;
        initConfig = msg.config;
        const db = openStateDb(msg.dbPath);
        stateBundle = {
          block: makeStateScope(
            db,
            "block",
            blockScopeKey(msg.flowName, msg.nodeId),
          ),
          flow: makeStateScope(db, "flow", msg.flowName),
          global: makeStateScope(db, "global", ""),
        };
        if (blockDef.subscribe) {
          // No triggering input message exists yet at this point — traceId/
          // seq/port are placeholders, meaningless for a subscribe call, kept
          // only so BlockContext stays one uniform shape across every block
          // lifecycle method rather than needing a second, narrower type.
          const ctx: BlockContext = {
            config: initConfig,
            state: stateBundle,
            log,
            traceId: "subscribe",
            seq: 0,
            port: "",
          };
          unsubscribe = await blockDef.subscribe(ctx, (port, payload) =>
            post({ type: "event", port, payload }),
          );
        }
        post({ type: "ready" });
      } catch (err) {
        post({
          type: "init_error",
          error:
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
      break;
    }
    case "exec": {
      if (!blockDef || !stateBundle) {
        post({
          type: "error",
          requestId: msg.requestId,
          error: "worker not initialized",
        });
        return;
      }
      const ctx: BlockContext = {
        config: initConfig,
        state: stateBundle,
        log,
        traceId: msg.traceId,
        seq: msg.seq,
        port: msg.port,
      };
      try {
        const outputs = await blockDef.process(msg.inputs, ctx);
        post({
          type: "result",
          requestId: msg.requestId,
          outputs: outputs ?? undefined,
        });
      } catch (err) {
        post({
          type: "error",
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "terminate":
      unsubscribe?.();
      break;
    case "hass.read.result": {
      const pending = pendingHassReads.get(msg.requestId);
      if (!pending) return;
      pendingHassReads.delete(msg.requestId);
      pending.resolve(msg.reading);
      break;
    }
    case "hass.call.result": {
      const pending = pendingHassCalls.get(msg.requestId);
      if (!pending) return;
      pendingHassCalls.delete(msg.requestId);
      if (msg.ok) pending.resolve();
      else pending.reject(new Error(msg.error));
      break;
    }
  }
});
