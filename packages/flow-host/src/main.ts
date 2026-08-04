import { join } from "node:path";
import type { BlockContext, LoadedFlow, Logger, NodeExecutor } from "flowbun";
import {
  assembleFlow,
  discoverBlocks,
  loadWiringFile,
  openStateDb,
  Router,
} from "flowbun";
import { performHassAction } from "flowbun/hass/action";
import { listHassEntities, readEntityState } from "flowbun/hass/client";
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
  const workerManager = new WorkerManager(flow, DATA_DIR, logger, (nodeId) =>
    send({ type: "node.dead", nodeId }),
  );
  const executor: NodeExecutor = new DistributedExecutor({
    flow,
    workerManager,
    send,
    log: logger,
    // Same deliberate cycle-break as setRouter() below: `router` is
    // assigned before any agent call (and hence any delta) can exist.
    emitDelta: (nodeId, payload) =>
      router.emitFromSource(nodeId, "delta", payload),
  });
  const router = new Router(flow, logger, executor);
  workerManager.setRouter(router);

  process.on("message", (raw: unknown) => {
    const msg = raw as CoordinatorToFlowHost;
    if (msg.type === "agent.result") {
      (executor as DistributedExecutor).handleAgentResult(msg);
    } else if (msg.type === "agent.delta") {
      (executor as DistributedExecutor).handleAgentDelta(msg);
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
    } else if (msg.type === "hass.state.query") {
      // Same borrowed-connection pattern as hass.entities.query above —
      // read-only, safe regardless of dry-run.
      readEntityState(msg.entity).then(
        (reading) =>
          send({
            type: "hass.state.result",
            requestId: msg.requestId,
            ok: true,
            reading,
          }),
        (err) =>
          send({
            type: "hass.state.result",
            requestId: msg.requestId,
            ok: false,
            error: String(err),
          }),
      );
    } else if (msg.type === "hass.action.request") {
      // The write side of the borrowed connection — dryRun was already
      // decided coordinator-side (see ipc/protocol.ts); logged here so the
      // call shows up in this flow's own log stream like any @hass/action.
      logger.info("hass.action.relayed", {
        call: msg.call,
        dryRun: msg.dryRun,
      });
      performHassAction(msg.call, msg.dryRun).then(
        () =>
          send({
            type: "hass.action.result",
            requestId: msg.requestId,
            ok: true,
          }),
        (err) =>
          send({
            type: "hass.action.result",
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
      } else if (node.block.kind !== "source" || !node.block.fireable) {
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: false,
          error: `node "${msg.nodeId}" is not fireable`,
        });
      } else if (node.disabled) {
        send({
          type: "flow.fireNode.result",
          requestId: msg.requestId,
          ok: false,
          error: `node "${msg.nodeId}" is disabled`,
        });
      } else {
        // "fired" is the fireable-source output-port convention — @core/inject
        // is the one block that sets `fireable: true` today, and its own
        // "fired" output port is what this targets.
        router.emitFromSource(msg.nodeId, "fired", { at: Date.now() });
        logger.info("node.fired", { node: msg.nodeId });
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

  // Sources hosted in this thread (kind: "source", hosted: "flow-host" —
  // only @hass/trigger today, for the flow's one real HA connection; see
  // WorkerManager's own doc comment) get no Worker at all (see
  // WorkerManager.startAll's needsWorker filter). Every other node —
  // including subscribe-bearing sources like @core/scheduler that don't
  // need this thread's capabilities — gets a real Worker instead, which is
  // where its own subscribe() actually runs (see worker-entry.ts's init
  // handler).
  await workerManager.startAll();

  const stopLocalSubscriptions: Array<() => void> = [];
  const hostedSubscriptions: Array<Promise<void>> = [];
  for (const [nodeId, node] of flow.nodes) {
    if (
      node.disabled ||
      node.block.kind !== "source" ||
      node.block.hosted !== "flow-host" ||
      !node.block.subscribe
    ) {
      continue;
    }
    // Calls the block's own subscribe() directly, exactly like
    // worker-entry.ts does for a Worker-hosted source — just in this
    // thread instead, since that's where the capability this source needs
    // (today, always the flow's HA connection) actually lives. Awaited
    // below (not fire-and-forget) so "ready" isn't sent until every hosted
    // source is actually live.
    const ctx: BlockContext = {
      config: node.config,
      state: {
        block: node.blockState,
        flow: flow.flowState,
        global: flow.globalState,
      },
      log: logger,
      traceId: "subscribe",
      seq: 0,
      port: "",
    };
    hostedSubscriptions.push(
      node.block
        .subscribe(ctx, (port, payload) =>
          router.emitFromSource(nodeId, port, payload),
        )
        .then((stop) => {
          stopLocalSubscriptions.push(stop);
        }),
    );
  }
  await Promise.all(hostedSubscriptions);

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
