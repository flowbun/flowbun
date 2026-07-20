import type {
  LoadedFlow,
  Logger,
  NodeExecutionRequest,
  NodeExecutor,
} from "flowbun";
import type { AgentConfig } from "flowbun/ai/agent";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { WorkerManager } from "./worker-manager";

// A margin over ai-host's own internal per-call timeout (see
// packages/ai-host/src/agent/node-agent.ts), not the primary timeout itself
// — the coordinator's relayed reply normally arrives well before this fires,
// carrying a specific "timed out after Nms" error. This is only a backstop
// against total silence (coordinator or ai-host process hung/crashed).
const AGENT_CALL_TIMEOUT_MARGIN_MS = 15_000;

interface PendingAgentCall {
  resolve: (result: {
    text: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
  }) => void;
  reject: (e: Error) => void;
}

/**
 * The flow-host's NodeExecutor: ordinary nodes — including @hass/action and
 * @hass/read — go to a persistent Worker (WorkerManager). A flow owns
 * exactly one real Home Assistant connection, held in the flow-host's main
 * thread; each Worker has no connection of its own and instead relays
 * "hass.read"/"hass.call" back to it (see hass/client.ts's
 * setHassReadTransport doc comment, and worker-entry.ts, which installs
 * that relay). @hass/trigger doesn't get a Worker at all — flow-host/src/
 * main.ts subscribes it directly off that same connection, so it never
 * reaches execute() here either. Only @ai/agent is relayed to the
 * coordinator over IPC instead of ever calling its process(): the
 * coordinator (and, onward from there, the dedicated ai-host process) is
 * the only place holding Claude credentials/session state. @core/scheduler
 * never reaches execute() at all (no wire can target its empty inputs).
 */
export class DistributedExecutor implements NodeExecutor {
  private pendingAgentCalls = new Map<number, PendingAgentCall>();
  private nextAgentRequestId = 1;

  constructor(
    private readonly deps: {
      flow: LoadedFlow;
      workerManager: WorkerManager;
      send: (msg: FlowHostToCoordinator) => void;
      log: Logger;
      /** Overridable for tests only — production always gets the real
       * AGENT_CALL_TIMEOUT_MARGIN_MS default. */
      agentCallTimeoutMarginMs?: number;
    },
  ) {}

  async execute(
    req: NodeExecutionRequest,
  ): Promise<Record<string, unknown> | undefined> {
    const node = this.deps.flow.nodes.get(req.nodeId);
    if (!node) throw new Error(`no such node "${req.nodeId}"`);

    if (node.block.name === "@ai/agent") {
      const config = node.config as AgentConfig;
      return this.callAgent(node.nodeId, config, req.inputs.prompt);
    }

    const requestId = this.deps.workerManager.allocRequestId();
    return this.deps.workerManager.exec(node.nodeId, requestId, {
      inputs: req.inputs,
      port: req.port,
      traceId: req.traceId,
      seq: req.seq,
    });
  }

  private callAgent(
    nodeId: string,
    config: AgentConfig,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const requestId = this.nextAgentRequestId++;
    this.deps.send({
      type: "agent.call",
      requestId,
      nodeId,
      input,
      config,
    });
    const marginMs =
      this.deps.agentCallTimeoutMarginMs ?? AGENT_CALL_TIMEOUT_MARGIN_MS;
    const timeoutMs = config.timeoutMs + marginMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentCalls.delete(requestId);
        this.deps.log.error("agent.call_timeout", { node: nodeId });
        reject(
          new Error(
            `@ai/agent call to "${nodeId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pendingAgentCalls.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve({ result });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  handleAgentResult(
    msg: Extract<CoordinatorToFlowHost, { type: "agent.result" }>,
  ): void {
    const pending = this.pendingAgentCalls.get(msg.requestId);
    if (!pending) return;
    this.pendingAgentCalls.delete(msg.requestId);
    if (msg.ok) {
      this.deps.log.info("agent.call", {
        costUsd: msg.costUsd,
        durationMs: msg.durationMs,
        numTurns: msg.numTurns,
      });
      pending.resolve({
        text: msg.text,
        costUsd: msg.costUsd,
        durationMs: msg.durationMs,
        numTurns: msg.numTurns,
      });
    } else {
      this.deps.log.error("agent.call_failed", { error: msg.error });
      pending.reject(new Error(msg.error));
    }
  }
}
