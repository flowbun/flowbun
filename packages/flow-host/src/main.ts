import { join } from "node:path";
import type { LoadedFlow, Logger, NodeExecutor } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  Router,
} from "flowbun";
import type {
  CoordinatorToFlowHost,
  FlowHostToCoordinator,
  LogRecord,
} from "flowbun/ipc";
import { DistributedExecutor } from "./distributed-executor";
import { WorkerManager } from "./worker-manager";

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(usage);
    process.exit(2);
  }
  return value;
}
const wiringPath = requireArg(
  process.argv[2],
  "usage: main.ts <wiring-json-path>",
);
const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");

function send(msg: FlowHostToCoordinator): void {
  (process as unknown as { send?: (m: unknown) => void }).send?.(msg);
}

async function main(): Promise<void> {
  const registry = await discoverBlocks(DATA_DIR);
  const wiring = await loadWiringFile(wiringPath);
  const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));
  const flow: LoadedFlow = assembleFlow(wiring, registry, db);

  function emit(
    level: LogRecord["level"],
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    const rec: LogRecord = {
      level,
      msg,
      meta,
      at: Date.now(),
      flow: flow.name,
      nodeId: typeof meta?.node === "string" ? meta.node : undefined,
    };
    console.log(JSON.stringify(rec));
    send({ type: "log", entries: [rec] });
  }
  const logger: Logger = {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };

  const workerManager = new WorkerManager(flow, DATA_DIR, logger);
  const executor: NodeExecutor = new DistributedExecutor({
    flow,
    workerManager,
    send,
    log: logger,
  });
  const router = new Router(flow, logger, executor);

  process.on("message", (raw: unknown) => {
    const msg = raw as CoordinatorToFlowHost;
    if (msg.type === "hass.event") {
      router.emitFromSource(msg.nodeId, msg.port, msg.payload, msg.traceId);
    } else if (msg.type === "hass.action.result") {
      (executor as DistributedExecutor).handleActionResult(msg);
    } else if (msg.type === "shutdown") {
      void shutdown();
    }
  });

  await workerManager.startAll();

  let reqId = 1;
  for (const [nodeId, node] of flow.nodes) {
    if (node.block.name === "@hass/trigger" && !node.disabled) {
      const entity = (node.config as { entity: string }).entity;
      send({ type: "hass.subscribe", requestId: reqId++, nodeId, entity });
    }
  }

  send({ type: "ready", flow: flow.name, nodeIds: [...flow.nodes.keys()] });
  logger.info("flow-host.ready", { pid: process.pid });

  async function shutdown(): Promise<void> {
    await workerManager.stopAll();
    db.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[flow-host] fatal:", err);
  process.exit(1);
});
