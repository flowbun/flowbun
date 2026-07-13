import { join } from "node:path";
import type { LoadedFlow, LoadedNode, Logger } from "flowbun";
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
  resolve: (o: Record<string, unknown> | undefined) => void;
  reject: (e: Error) => void;
}

/**
 * One persistent Worker per ordinary (non-@hass/*) node, spawned once in
 * startAll() and kept alive for the flow-host's whole lifetime — never
 * per-message. This is the concrete mitigation for S1's flagged RSS-growth
 * risk: that spike stress-tested rapid repeated spawn/terminate, which this
 * design never does (a worker is only recreated on its own crash/hang, or
 * when the whole flow-host restarts).
 */
export class WorkerManager {
  private workers = new Map<string, ManagedWorker>();
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;

  constructor(
    private readonly flow: LoadedFlow,
    private readonly dataDir: string,
    private readonly log: Logger,
  ) {}

  async startAll(): Promise<void> {
    const dbPath = join(this.dataDir, "state", "flowbun.sqlite");
    await Promise.all(
      [...this.flow.nodes]
        .filter(
          ([, n]) =>
            !n.block.name.startsWith("@hass/") &&
            n.block.name !== "@ai/agent" &&
            !n.disabled,
        )
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
      },
    );
    managed.worker.addEventListener("error", (e) => {
      this.log.error("worker.crashed", {
        node: managed.nodeId,
        message: (e as ErrorEvent).message,
      });
      void this.respawn(managed);
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
      }, WORKER_EXEC_TIMEOUT_MS);
      this.pending.set(requestId, {
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
      const msg: FlowHostToWorker = { type: "exec", requestId, ...req };
      managed.worker.postMessage(msg);
    });
  }

  async stopAll(): Promise<void> {
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
