import { join } from "node:path";
import type { LoadedFlow, Logger, NodeExecutor } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  Router,
} from "flowbun";
import type { SchedulerConfig } from "flowbun/core/scheduler";
import { registerScheduler } from "flowbun/core/scheduler";
import { listHassEntities } from "flowbun/hass/client";
import type { TriggerConfig } from "flowbun/hass/trigger";
import { registerHassTrigger } from "flowbun/hass/trigger";
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

  // Constructed in this order specifically to break a real cycle:
  // WorkerManager needs Router (to route an "event" message from a
  // subscribing block's Worker, e.g. @hass/trigger), Router needs a
  // NodeExecutor (DistributedExecutor), and DistributedExecutor needs
  // WorkerManager (to call .exec()). setRouter() closes the loop after
  // everything else is constructed, always before startAll() below spawns
  // any Worker that could possibly emit an "event" — see WorkerManager's
  // own doc comment on setRouter().
  const workerManager = new WorkerManager(flow, DATA_DIR, logger);
  const executor: NodeExecutor = new DistributedExecutor({
    flow,
    workerManager,
    send,
    log: logger,
  });
  const router = new Router(flow, logger, executor);
  workerManager.setRouter(router);

  process.on("message", (raw: unknown) => {
    const msg = raw as CoordinatorToFlowHost;
    if (msg.type === "agent.result") {
      (executor as DistributedExecutor).handleAgentResult(msg);
    } else if (msg.type === "hass.entities.query") {
      // Lazily bootstraps this flow-host's own HA connection if it hasn't
      // already opened one — see hass/client.ts's getHass(). Purely a
      // read-only convenience query, not something any node's real
      // execution depends on.
      listHassEntities().then(
        (entities) =>
          send({
            type: "hass.entities.result",
            requestId: msg.requestId,
            ok: true,
            entities,
          }),
        (err) =>
          send({
            type: "hass.entities.result",
            requestId: msg.requestId,
            ok: false,
            error: String(err),
          }),
      );
    } else if (msg.type === "flow.fireNode") {
      const node = flow.nodes.get(msg.nodeId);
      if (!node) {
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: false,
          error: `no such node "${msg.nodeId}"`,
        });
      } else if (node.block.name !== "@core/inject") {
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: false,
          error: `node "${msg.nodeId}" is not a @core/inject node`,
        });
      } else if (node.disabled) {
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: false,
          error: `node "${msg.nodeId}" is disabled`,
        });
      } else {
        router.emitFromSource(msg.nodeId, "fired", { at: Date.now() });
        logger.info("inject.fired", { node: msg.nodeId });
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: true,
        });
      }
    } else if (msg.type === "shutdown") {
      void shutdown();
    }
  });

  // @hass/trigger nodes get no Worker at all (see WorkerManager.startAll's
  // filter) — they're handled directly below, right alongside
  // @core/scheduler, since both are node types the flow-host itself owns
  // rather than delegating to a per-node Worker.
  await workerManager.startAll();

  const stopLocalSubscriptions: Array<() => void> = [];
  const triggerSubscriptions: Array<Promise<void>> = [];
  for (const [nodeId, node] of flow.nodes) {
    if (node.block.name === "@core/scheduler" && !node.disabled) {
      // Runs entirely locally — a timer isn't a shared external resource
      // anything else needs to own, so this never goes over IPC (see
      // core/scheduler.ts's own doc comment).
      stopLocalSubscriptions.push(
        registerScheduler(node.config as SchedulerConfig, (payload) =>
          router.emitFromSource(nodeId, "fired", payload),
        ),
      );
    } else if (node.block.name === "@hass/trigger" && !node.disabled) {
      // The flow's one real Home Assistant connection lives here, in the
      // flow-host's own main thread (see hass/client.ts's
      // setHassReadTransport doc comment and WorkerManager's own doc
      // comment) — not in a Worker, so this subscribes directly rather than
      // going through workerManager.exec(). registerHassTrigger() awaits
      // getHass() internally, which is what actually opens the connection
      // the first time any node needs it. Awaited below (not fire-and-
      // forget) so "ready" isn't sent until every trigger is actually live
      // — matching the guarantee the old per-node-Worker init used to give
      // for free via workerManager.startAll()'s own await.
      triggerSubscriptions.push(
        registerHassTrigger(node.config as TriggerConfig, (payload) =>
          router.emitFromSource(nodeId, "changed", payload),
        ).then((stop) => {
          stopLocalSubscriptions.push(stop);
        }),
      );
    }
  }
  await Promise.all(triggerSubscriptions);

  send({ type: "ready", flow: flow.name, nodeIds: [...flow.nodes.keys()] });
  logger.info("flow-host.ready", { pid: process.pid });

  async function shutdown(): Promise<void> {
    for (const stop of stopLocalSubscriptions) stop();
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
