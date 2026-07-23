import { join } from "node:path";
import type {
  AnyBlockDef,
  LoadedFlow,
  LoadedNode,
  Logger,
  Router,
} from "flowbun";
import { performHassAction } from "flowbun/hass/action";
import { readEntityState } from "flowbun/hass/client";
import { listExposedEntities } from "flowbun/hass/exposed-entities";
import type { FlowHostToWorker, WorkerToFlowHost } from "flowbun/ipc";

const WORKER_INIT_TIMEOUT_MS = 5_000;
const WORKER_EXEC_TIMEOUT_MS = 10_000;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 60_000;

interface ManagedWorker {
  nodeId: string;
  node: LoadedNode;
  worker: Worker;
  respawnTimestamps: number[];
  dead: boolean;
}

interface Pending {
  nodeId: string;
  resolve: (o: Record<string, unknown> | undefined) => void;
  reject: (e: Error) => void;
}

/**
 * A node needs a Worker unless something else entirely owns its execution:
 * a "relay" block (only @ai/agent today) is IPC-relayed to the coordinator
 * and never runs locally at all; a "source" block hosted in the flow-host's
 * own main thread (only @hass/trigger today, for its HA connection — see
 * this class's own doc comment) is subscribed there directly instead; and a
 * source with no `subscribe` at all (only @core/inject today) never runs
 * any code autonomously — it's only ever fired externally via
 * router.emitFromSource(), which doesn't touch a Worker either. Every other
 * node — every transform, every duplex (whose subscribe AND process both
 * need the same Worker — see block.ts's DuplexBlockDef doc comment), and
 * every subscribe-bearing source that isn't flow-host-hosted (e.g.
 * @core/scheduler) — gets a real Worker.
 */
function needsWorker(block: AnyBlockDef): boolean {
  if (block.kind === "relay") return false;
  if (block.kind === "source") {
    if (block.hosted === "flow-host") return false;
    if (!block.subscribe) return false;
  }
  return true;
}

/**
 * One persistent Worker per node that needs one (see needsWorker above),
 * spawned once in startAll() and kept alive for the flow-host's whole
 * lifetime — never per-message. This is the concrete mitigation for S1's
 * flagged RSS-growth risk: that spike stress-tested rapid repeated
 * spawn/terminate, which this design never does (a worker is only recreated
 * on its own crash/hang, or when the whole flow-host restarts).
 *
 * A flow owns exactly one real Home Assistant connection, not one per node:
 * it's opened lazily, right here in the flow-host's own main thread, the
 * first time this class actually calls readEntityState()/performHassAction()
 * below — not inside any Worker. @hass/action/@hass/read nodes (and any
 * ordinary block, like battery_controller, that calls readEntityState()/
 * performHassAction() directly) still get a Worker like any other node, but
 * that Worker has no connection of its own — it relays "hass.read"/
 * "hass.call" here instead (see hass/client.ts's setHassReadTransport doc
 * comment, and worker-entry.ts, which installs that relay).
 */
export class WorkerManager {
  private workers = new Map<string, ManagedWorker>();
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;
  // Set via setRouter(), not the constructor: Router's own constructor needs
  // a NodeExecutor (DistributedExecutor), which itself needs a WorkerManager
  // — a genuine construction-order cycle. main.ts breaks it by constructing
  // this class first, then DistributedExecutor, then Router, then calling
  // setRouter() — always before startAll() spawns any Worker that could
  // possibly emit an "event" message this needs to route.
  private router: Router | undefined;
  // Set at the top of stopAll() -- suppresses handleDeath() during a
  // deliberate shutdown, so terminating every worker to tear down the
  // flow-host doesn't spawn a fresh replacement for each one just to
  // immediately abandon it.
  private stopping = false;

  constructor(
    private readonly flow: LoadedFlow,
    private readonly dataDir: string,
    private readonly log: Logger,
    // Called exactly once per node the moment it's marked permanently dead
    // (respawn budget exhausted) -- lets main.ts report it up to the
    // coordinator (see ipc/protocol.ts's "node.dead") instead of the node
    // silently vanishing while the flow-host itself keeps reporting "ready".
    private readonly onNodeDead?: (nodeId: string) => void,
  ) {}

  setRouter(router: Router): void {
    this.router = router;
  }

  async startAll(): Promise<void> {
    const dbPath = join(this.dataDir, "state", "flowbun.sqlite");
    await Promise.all(
      [...this.flow.nodes]
        .filter(([, n]) => needsWorker(n.block) && !n.disabled)
        .map(([nodeId, node]) => this.spawn(nodeId, node, dbPath)),
    );
  }

  private async spawn(
    nodeId: string,
    node: LoadedNode,
    dbPath: string,
  ): Promise<void> {
    const worker = new Worker(
      new URL("./worker-entry.ts", import.meta.url).href,
    );
    const managed: ManagedWorker = {
      nodeId,
      node,
      worker,
      respawnTimestamps: [],
      dead: false,
    };
    this.workers.set(nodeId, managed);
    this.wire(managed);
    await this.init(managed, dbPath);
  }

  private wire(managed: ManagedWorker): void {
    // Captured once per Worker instance (wire() is called fresh on every
    // spawn/respawn) so a stale event from an already-superseded worker
    // (e.g. a delayed "close" arriving after respawn() has already swapped
    // in a replacement) is a no-op purely by identity, with no extra
    // bookkeeping needed. `handledDeath` similarly guards against "error"
    // and "close" both firing for the same crash and double-consuming the
    // respawn budget (see respawn()'s own MAX_RESPAWNS check).
    const thisWorker = managed.worker;
    let handledDeath = false;
    const handleDeath = (reason: string): void => {
      if (
        managed.dead ||
        this.stopping ||
        managed.worker !== thisWorker ||
        handledDeath
      ) {
        return;
      }
      handledDeath = true;
      // Reject any exec() still in flight against this worker before
      // respawning: each Pending's own reject() clears its exec() timeout
      // as a side effect, so this also prevents that timeout from firing
      // ~WORKER_EXEC_TIMEOUT_MS later and calling respawn() a second time
      // for the same death. Snapshot into an array first since reject()
      // mutates this.pending mid-loop.
      for (const [, entry] of [...this.pending]) {
        if (entry.nodeId === managed.nodeId) {
          entry.reject(new Error(`${reason}: ${managed.nodeId}`));
        }
      }
      void this.respawn(managed);
    };

    managed.worker.addEventListener(
      "message",
      (e: MessageEvent<WorkerToFlowHost>) => {
        const msg = e.data;
        if (msg.type === "result")
          this.pending.get(msg.requestId)?.resolve(msg.outputs);
        else if (msg.type === "error")
          this.pending.get(msg.requestId)?.reject(new Error(msg.error));
        else if (msg.type === "log")
          this.log[msg.level](msg.msg, { ...msg.meta, node: managed.nodeId });
        else if (msg.type === "event") {
          if (!this.router) {
            this.log.error("worker.event_before_router_set", {
              node: managed.nodeId,
            });
            return;
          }
          this.router.emitFromSource(managed.nodeId, msg.port, msg.payload);
        } else if (msg.type === "hass.read") {
          readEntityState(msg.entity).then(
            (reading) => {
              const reply: FlowHostToWorker = {
                type: "hass.read.result",
                requestId: msg.requestId,
                reading,
              };
              managed.worker.postMessage(reply);
            },
            (err) => {
              this.log.error("hass.read_failed", {
                node: managed.nodeId,
                entity: msg.entity,
                err: String(err),
              });
              const reply: FlowHostToWorker = {
                type: "hass.read.result",
                requestId: msg.requestId,
                reading: undefined,
              };
              managed.worker.postMessage(reply);
            },
          );
        } else if (msg.type === "hass.call") {
          performHassAction(msg.call, msg.dryRun).then(
            () => {
              const reply: FlowHostToWorker = {
                type: "hass.call.result",
                requestId: msg.requestId,
                ok: true,
              };
              managed.worker.postMessage(reply);
            },
            (err) => {
              const reply: FlowHostToWorker = {
                type: "hass.call.result",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              };
              managed.worker.postMessage(reply);
            },
          );
        } else if (msg.type === "hass.exposedEntities") {
          // listExposedEntities() never throws/rejects (see its own doc
          // comment — every failure degrades to []), so there's no error
          // branch to relay here, unlike hass.read/hass.call above.
          listExposedEntities(msg.assistant).then((entities) => {
            const reply: FlowHostToWorker = {
              type: "hass.exposedEntities.result",
              requestId: msg.requestId,
              entities,
            };
            managed.worker.postMessage(reply);
          });
        }
      },
    );
    managed.worker.addEventListener("error", (e) => {
      this.log.error("worker.crashed", {
        node: managed.nodeId,
        message: (e as ErrorEvent).message,
      });
      handleDeath("worker crashed");
    });
    // Bun's Worker emits "close" on any thread exit, not just uncaught
    // exceptions -- a block calling process.exit(), an OOM kill, or any
    // other silent exit previously left this node's ManagedWorker looking
    // alive forever (not "dead", but with no worker left to answer exec()),
    // since only "error" was ever handled. Routed through the same
    // handleDeath() as "error" so a genuine crash (which fires both) still
    // only respawns once.
    managed.worker.addEventListener("close", () => {
      this.log.error("worker.closed_unexpectedly", { node: managed.nodeId });
      handleDeath("worker closed unexpectedly");
    });
  }

  private init(managed: ManagedWorker, dbPath: string): Promise<void> {
    const msg: FlowHostToWorker = {
      type: "init",
      nodeId: managed.nodeId,
      flowName: this.flow.name,
      blockModulePath: managed.node.blockModulePath,
      config: managed.node.config,
      dbPath,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`worker init timeout: ${managed.nodeId}`)),
        WORKER_INIT_TIMEOUT_MS,
      );
      const onMsg = (e: MessageEvent<WorkerToFlowHost>) => {
        if (e.data.type === "ready") {
          clearTimeout(timer);
          managed.worker.removeEventListener("message", onMsg);
          resolve();
        } else if (e.data.type === "init_error") {
          clearTimeout(timer);
          managed.worker.removeEventListener("message", onMsg);
          reject(new Error(e.data.error));
        }
      };
      managed.worker.addEventListener("message", onMsg);
      managed.worker.postMessage(msg);
    });
  }

  private async respawn(managed: ManagedWorker): Promise<void> {
    const now = Date.now();
    managed.respawnTimestamps = managed.respawnTimestamps.filter(
      (t) => now - t < RESPAWN_WINDOW_MS,
    );
    managed.respawnTimestamps.push(now);
    if (managed.respawnTimestamps.length > MAX_RESPAWNS) {
      managed.dead = true;
      this.log.error("worker.respawn_limit_exceeded", { node: managed.nodeId });
      this.onNodeDead?.(managed.nodeId);
      return;
    }
    try {
      managed.worker.terminate();
    } catch {
      // already dead
    }
    managed.worker = new Worker(
      new URL("./worker-entry.ts", import.meta.url).href,
    );
    this.wire(managed);
    const dbPath = join(this.dataDir, "state", "flowbun.sqlite");
    try {
      await this.init(managed, dbPath);
    } catch (err) {
      this.log.error("worker.respawn_failed", {
        node: managed.nodeId,
        err: String(err),
      });
      // Previously left the node here: not dead, but with a worker that
      // never got past init -- every future exec() would hit it and get a
      // misleading "worker not initialized" forever, with no further retry
      // and no respawn budget consumed. Retrying through respawn() itself
      // re-enters the same budget check above, so this either recovers
      // (e.g. a transient failure under load) or converges to dead:true
      // once MAX_RESPAWNS is actually exhausted -- bounded recursion, at
      // most MAX_RESPAWNS deep.
      await this.respawn(managed);
    }
  }

  allocRequestId(): number {
    return this.nextRequestId++;
  }

  exec(
    nodeId: string,
    requestId: number,
    req: {
      inputs: Record<string, unknown>;
      port: string;
      traceId: string;
      seq: number;
      /** Per-call override of WORKER_EXEC_TIMEOUT_MS — see DistributedExecutor's
       * own doc comment on where this comes from and why it exists (a node
       * whose own work can legitimately run longer than the 10s default,
       * e.g. a slow network call with its own configurable budget). Absent
       * for the overwhelming majority of nodes, which get the plain
       * default. */
      timeoutMs?: number;
    },
  ): Promise<Record<string, unknown> | undefined> {
    const managed = this.workers.get(nodeId);
    if (!managed || managed.dead)
      return Promise.reject(new Error(`node "${nodeId}" has no live worker`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`worker exec timeout: ${nodeId}`));
        void this.respawn(managed);
      }, req.timeoutMs ?? WORKER_EXEC_TIMEOUT_MS);
      this.pending.set(requestId, {
        nodeId,
        resolve: (o) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(o);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(e);
        },
      });
      // timeoutMs governs this method's own kill-timer above only — the
      // Worker's exec message has no use for it and FlowHostToWorker's
      // "exec" variant doesn't declare the field, so it's deliberately
      // excluded here rather than spread in.
      const { inputs, port, traceId, seq } = req;
      const msg: FlowHostToWorker = {
        type: "exec",
        requestId,
        inputs,
        port,
        traceId,
        seq,
      };
      managed.worker.postMessage(msg);
    });
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const managed of this.workers.values()) {
      try {
        managed.worker.postMessage({
          type: "terminate",
        } satisfies FlowHostToWorker);
      } catch {
        // ignore
      }
      managed.worker.terminate();
    }
  }
}
