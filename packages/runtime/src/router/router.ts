import type { Logger } from "../block";
import { InProcessExecutor, type NodeExecutor } from "./executor";
import type { Envelope, LoadedFlow, QueuedDelivery } from "./types";

/**
 * Node-RED-style single-port firing: `process()` is invoked once per message
 * arriving at one named input port, with `inputs` containing only that port's
 * value. See block.ts's doc comment on `defineBlock` for the full rationale.
 *
 * Delivery is concurrent ACROSS nodes but sequential WITHIN one node: each
 * node gets its own FIFO queue and its own independent drain loop (see
 * `nodeQueues`/`nodeDrains` below), so when one node's output fans out to
 * several different destination nodes, those destinations execute truly
 * concurrently — each one's `executor.execute()` call (a real Worker
 * round-trip, or a real HTTP/IPC call for a relay block) can be in flight at
 * the same wall-clock time as its siblings', instead of queued behind them.
 * A single node's OWN successive deliveries stay strictly ordered, though:
 * `ctx.state.block`/`ctx.state.flow`/`ctx.state.global` are exposed to block
 * authors as a plain get-then-set API (see state/state-api.ts — `set()`
 * itself is one atomic SQL upsert, but a block doing "read a key, compute,
 * write it back" spans two separate `await`s), and plenty of real blocks in
 * this codebase do exactly that (voice_gate's own conversation-history
 * append, among others). Re-entering the same node's process() concurrently
 * would turn that ordinary read-modify-write pattern into a lost-update race
 * — something no existing block author had to defend against, since the
 * router was fully single-concurrency until now. Serializing same-node
 * deliveries preserves that guarantee while still delivering genuine
 * parallelism for the case that actually matters for throughput: sibling
 * branches of a fan-out, and independent chains triggered around the same
 * time.
 *
 * This does NOT protect state shared ACROSS different nodes (two distinct
 * blocks both doing read-modify-write on the same flow/global-scope key) —
 * that was only ever accidentally safe before, as a side effect of the
 * entire router being single-threaded; a flow deliberately designed that way
 * needs its own coordination now, same as any genuinely concurrent system.
 */
export class Router {
  private seq = 0;
  private readonly nodeQueues = new Map<string, QueuedDelivery[]>();
  private readonly nodeDrains = new Map<string, Promise<void>>();
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
   *
   * Logs its own "router.produced" first, matching deliver()'s shape
   * exactly (same node/outputs/seq/traceId fields) — without this, a
   * trigger's firing was invisible to anything watching for "router.produced"
   * (the editor's wire-activity-dot animation among them: every wire *out*
   * of a trigger never lit up, only the ones further downstream, since
   * deliver() is never reached for the trigger node itself). Also threads
   * this event's own seq through as the downstream deliveries' causationSeq
   * (previously always null for trigger-originated chains), so a trigger
   * firing is now traceable the same way any other node's output is.
   */
  emitFromSource(
    nodeId: string,
    port: string,
    payload: unknown,
    traceId?: string,
  ): string {
    const tid = traceId ?? crypto.randomUUID();
    const seq = ++this.seq;
    this.log.info("router.produced", {
      flow: this.flow.name,
      node: nodeId,
      outputs: { [port]: payload },
      seq,
      traceId: tid,
    });
    this.fanOut(nodeId, port, payload, tid, seq);
    return tid;
  }

  /**
   * Resolves once every currently-in-flight delivery, across every node's
   * own queue, has settled — including deliveries spawned AFTER this was
   * called as a result of ones already in flight (a fan-out reached mid-wait
   * can itself spawn new per-node drains this method hasn't seen yet), which
   * is why this re-snapshots `nodeDrains` in a loop rather than awaiting one
   * fixed set: a single `Promise.all` over the initial snapshot could
   * resolve before a late-spawned sibling or grandchild delivery has
   * actually finished.
   */
  async waitForIdle(): Promise<void> {
    let pending = [...this.nodeDrains.values()];
    while (pending.length > 0) {
      await Promise.all(pending);
      pending = [...this.nodeDrains.values()];
    }
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
    const queue = this.nodeQueues.get(nodeId);
    if (queue) {
      queue.push({ nodeId, port, payload, envelope });
    } else {
      this.nodeQueues.set(nodeId, [{ nodeId, port, payload, envelope }]);
    }
    this.log.debug("router.enqueue", {
      flow: this.flow.name,
      nodeId,
      port,
      seq,
      traceId,
      causationSeq,
    });
    // Only start a new drain if this node has none running — an existing
    // drain's own while-loop re-checks its queue after every delivery, so it
    // will pick up this just-pushed item on its own without needing a
    // second, concurrently-running drain for the same node (which is
    // exactly the case this class's own doc comment says must never happen).
    if (!this.nodeDrains.has(nodeId)) {
      const drainPromise = this.drainNode(nodeId).finally(() => {
        this.nodeDrains.delete(nodeId);
      });
      this.nodeDrains.set(nodeId, drainPromise);
    }
  }

  /** One node's own independent FIFO drain loop — see this class's own doc
   * comment for why deliveries to the same node stay strictly ordered while
   * different nodes' drain loops run fully concurrently with each other. */
  private async drainNode(nodeId: string): Promise<void> {
    const queue = this.nodeQueues.get(nodeId);
    if (!queue) return;
    for (let item = queue.shift(); item; item = queue.shift()) {
      await this.deliver(item);
    }
    this.nodeQueues.delete(nodeId);
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

  /** Enqueues `value` to every node wired to `sourceNodeId.sourcePort` —
   * each destination gets its own per-node queue (see enqueue()), so
   * multiple destinations from one fan-out run concurrently with each
   * other. Shared by deliver()'s post-process fan-out and emitFromSource(). */
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
