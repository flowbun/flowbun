import type { BlockContext, Logger } from "../block";
import type { LoadedFlow } from "./types";

export interface NodeExecutionRequest {
  nodeId: string;
  inputs: Record<string, unknown>;
  port: string;
  traceId: string;
  seq: number;
}

/**
 * Swappable strategy for actually running a node's block.process(). Router
 * doesn't know or care whether this happens in-process, in a Worker thread,
 * or via IPC relay to another process — it only awaits execute().
 */
export interface NodeExecutor {
  execute(
    req: NodeExecutionRequest,
  ): Promise<Record<string, unknown> | undefined>;
}

/** Phase-1 behavior: calls block.process() directly, in-process. Router's default executor. */
export class InProcessExecutor implements NodeExecutor {
  constructor(
    private readonly flow: LoadedFlow,
    private readonly log: Logger,
  ) {}

  async execute(
    req: NodeExecutionRequest,
  ): Promise<Record<string, unknown> | undefined> {
    const inst = this.flow.nodes.get(req.nodeId);
    if (!inst)
      throw new Error(
        `no such node "${req.nodeId}" in flow "${this.flow.name}"`,
      );
    // A source or relay block never has its process() called (see
    // block.ts's SourceBlockDef/RelayBlockDef doc comments) — nothing wires
    // into a source's empty inputs, and a relay block is dispatched
    // elsewhere entirely, so execute() should never actually be reached for
    // either. Guarded rather than assumed, same as worker-entry.ts's own
    // exec handler in the distributed topology.
    if (inst.block.kind === "source" || inst.block.kind === "relay") {
      throw new Error(
        `block "${inst.block.name}" (kind: "${inst.block.kind}") has no process() to execute`,
      );
    }

    const ctx: BlockContext = {
      config: inst.config,
      state: {
        block: inst.blockState,
        flow: this.flow.flowState,
        global: this.flow.globalState,
      },
      log: this.log,
      traceId: req.traceId,
      seq: req.seq,
      port: req.port,
    };
    return (await inst.block.process(req.inputs, ctx)) ?? undefined;
  }
}
