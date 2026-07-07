import type { AnyBlockDef, BlockContext } from "flowbun";
import { blockScopeKey, makeStateScope, openStateDb } from "flowbun";
import type { FlowHostToWorker, WorkerToFlowHost } from "flowbun/ipc";

let blockDef: AnyBlockDef | undefined;
let stateBundle: BlockContext["state"] | undefined;
let initConfig: unknown;

function post(msg: WorkerToFlowHost): void {
  postMessage(msg);
}

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
      break;
  }
});
