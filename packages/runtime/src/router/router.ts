import type { BlockContext, Logger } from "../block";
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

  constructor(
    private readonly flow: LoadedFlow,
    private readonly log: Logger,
  ) {}

  /** External entry point: trigger blocks / a demo runner call this to inject a message. */
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

    const ctx: BlockContext = {
      config: inst.config,
      state: {
        block: inst.blockState,
        flow: this.flow.flowState,
        global: this.flow.globalState,
      },
      log: this.log,
      traceId: item.envelope.traceId,
      seq: item.envelope.seq,
      port: item.port,
    };
    const inputs = { [item.port]: item.payload };

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
      outputs = await inst.block.process(inputs, ctx);
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
      const destinations =
        this.flow.wireIndex.get(`${item.nodeId}.${outPort}`) ?? [];
      for (const dest of destinations) {
        this.enqueue(
          dest.nodeId,
          dest.port,
          structuredClone(value),
          item.envelope.traceId,
          item.envelope.seq,
        );
      }
    }
  }
}
