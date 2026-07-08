import type { Logger } from "../block";
import { InProcessExecutor, type NodeExecutor } from "./executor";
import type { Envelope, LoadedFlow, QueuedDelivery } from "./types";

/**
 * Node-RED-style single-port firing: `process()` is invoked once per message
 * arriving at one named input port, with `inputs` containing only that port's
 * value. See block.ts's doc comment on `defineBlock` for the full rationale.
 *
 * Delivery is a simple sequential drain loop (concurrency 1) — deterministic
 * trace ordering, correct for home-automation message rates. This is a
 * deliberate Phase-1 simplification, not a throughput design.
 */
export class Router {
  private seq = 0;
  private queue: QueuedDelivery[] = [];
  private drainPromise: Promise<void> | null = null;
  private readonly executor: NodeExecutor;

  constructor(
    private readonly flow: LoadedFlow,
    private readonly log: Logger,
    executor?: NodeExecutor,
  ) {
    this.executor = executor ?? new InProcessExecutor(flow, log);
  }

  /** External entry point: a demo runner / test harness calls this to inject a payload directly into a real node's real input port. */
  ingress(
    nodeId: string,
    port: string,
    payload: unknown,
    traceId?: string,
  ): string {
    const tid = traceId ?? crypto.randomUUID();
    this.enqueue(nodeId, port, payload, tid, null);
    return tid;
  }

  /**
   * External entry point for source nodes (@hass/trigger) whose payload was
   * produced at an OUTPUT port, not received at an input — fans out to
   * whatever's wired to `sourceNodeId.sourcePort`, exactly like deliver()'s
   * own post-process fan-out, rather than trying to invoke the source node's
   * own (nonexistent/no-op) process(). Using `ingress()` for this was a
   * latent bug: it silently no-op'd against Phase 1's in-process executor
   * (@hass/trigger's process() is a documented no-op) and only surfaced as a
   * hard failure once Phase 2's DistributedExecutor required every ordinary
   * node to have a live Worker.
   */
  emitFromSource(
    nodeId: string,
    port: string,
    payload: unknown,
    traceId?: string,
  ): string {
    const tid = traceId ?? crypto.randomUUID();
    this.fanOut(nodeId, port, payload, tid, null);
    return tid;
  }

  waitForIdle(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  private enqueue(
    nodeId: string,
    port: string,
    payload: unknown,
    traceId: string,
    causationSeq: number | null,
  ): void {
    const seq = ++this.seq;
    const envelope: Envelope = {
      seq,
      traceId,
      causationSeq,
      emittedAt: Date.now(),
    };
    this.queue.push({ nodeId, port, payload, envelope });
    this.log.debug("router.enqueue", {
      flow: this.flow.name,
      nodeId,
      port,
      seq,
      traceId,
      causationSeq,
    });
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
      });
    }
  }

  private async drain(): Promise<void> {
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      await this.deliver(item);
    }
  }

  private async deliver(item: QueuedDelivery): Promise<void> {
    const inst = this.flow.nodes.get(item.nodeId);
    if (!inst) {
      this.log.warn("router.no_such_node", {
        flow: this.flow.name,
        nodeId: item.nodeId,
      });
      return;
    }
    if (inst.disabled) {
      this.log.debug("router.node_disabled", {
        flow: this.flow.name,
        nodeId: item.nodeId,
      });
      return;
    }

    this.log.info("router.deliver", {
      flow: this.flow.name,
      node: item.nodeId,
      block: inst.block.name,
      port: item.port,
      payload: item.payload,
      seq: item.envelope.seq,
      causationSeq: item.envelope.causationSeq,
      traceId: item.envelope.traceId,
    });

    let outputs: Record<string, unknown> | undefined;
    try {
      outputs = await this.executor.execute({
        nodeId: item.nodeId,
        inputs: { [item.port]: item.payload },
        port: item.port,
        traceId: item.envelope.traceId,
        seq: item.envelope.seq,
      });
    } catch (err) {
      this.log.error("router.block_threw", {
        flow: this.flow.name,
        node: item.nodeId,
        err: String(err),
        traceId: item.envelope.traceId,
      });
      return;
    }
    if (!outputs) return;

    this.log.info("router.produced", {
      flow: this.flow.name,
      node: item.nodeId,
      outputs,
      seq: item.envelope.seq,
      traceId: item.envelope.traceId,
    });

    for (const [outPort, value] of Object.entries(outputs)) {
      if (value === undefined) continue;
      this.fanOut(
        item.nodeId,
        outPort,
        value,
        item.envelope.traceId,
        item.envelope.seq,
      );
    }
  }

  /** Enqueues `value` to every node wired to `sourceNodeId.sourcePort`. Shared by deliver()'s post-process fan-out and emitFromSource(). */
  private fanOut(
    sourceNodeId: string,
    sourcePort: string,
    value: unknown,
    traceId: string,
    causationSeq: number | null,
  ): void {
    const destinations =
      this.flow.wireIndex.get(`${sourceNodeId}.${sourcePort}`) ?? [];
    for (const dest of destinations) {
      this.enqueue(
        dest.nodeId,
        dest.port,
        structuredClone(value),
        traceId,
        causationSeq,
      );
    }
  }
}
