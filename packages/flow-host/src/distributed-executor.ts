import type {
  LoadedFlow,
  Logger,
  NodeExecutionRequest,
  NodeExecutor,
} from "flowbun";
import type { AgentConfig } from "flowbun/ai/agent";
import type { ActionCall, ActionConfig } from "flowbun/hass/action";
import type { EntityStateReading } from "flowbun/hass/client";
import type { ReadConfig } from "flowbun/hass/read";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { WorkerManager } from "./worker-manager";

// Real-incident-driven: on 2026-07-10, a malformed Home Assistant response
// to a service call left the underlying @digital-alchemy/hass promise
// permanently unsettled — with no timeout here, the flow-host's pending
// promise for that one action never resolved either, and since Router's
// delivery queue is strictly sequential (concurrency 1, one delivery
// awaited at a time), that single hung call froze the *entire* flow for
// the next 14+ hours: every subsequent trigger kept enqueueing correctly,
// none of it was ever delivered. WorkerManager.exec() already had this
// exact protection (WORKER_EXEC_TIMEOUT_MS) for ordinary Worker-executed
// nodes; @hass/action/@hass/read's IPC relay to the coordinator was the
// one path that didn't.
const HASS_CALL_TIMEOUT_MS = 10_000;

// A margin over ai-host's own internal per-call timeout (see
// packages/ai-host/src/agent/node-agent.ts), not the primary timeout itself
// — the coordinator's relayed reply normally arrives well before this fires,
// carrying a specific "timed out after Nms" error. This is only a backstop
// against total silence (coordinator or ai-host process hung/crashed).
const AGENT_CALL_TIMEOUT_MARGIN_MS = 15_000;

interface PendingAction {
  resolve: () => void;
  reject: (e: Error) => void;
}

interface PendingRead {
  resolve: (reading: EntityStateReading) => void;
  reject: (e: Error) => void;
}

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
 * The flow-host's NodeExecutor: ordinary nodes go to a persistent Worker
 * (WorkerManager); @hass/action and @hass/read nodes are relayed to the
 * coordinator over IPC instead of ever calling their process() — the
 * coordinator is the only process holding the real HA connection.
 * @ai/agent nodes are likewise relayed — the coordinator (and, onward from
 * there, the dedicated ai-host process) is the only place holding Claude
 * credentials/session state. @hass/trigger and @core/scheduler nodes never
 * reach execute() at all (no wire can target their empty inputs).
 */
export class DistributedExecutor implements NodeExecutor {
  private pendingActions = new Map<number, PendingAction>();
  private nextActionRequestId = 1;
  private pendingReads = new Map<number, PendingRead>();
  private nextReadRequestId = 1;
  private pendingAgentCalls = new Map<number, PendingAgentCall>();
  private nextAgentRequestId = 1;

  constructor(
    private readonly deps: {
      flow: LoadedFlow;
      workerManager: WorkerManager;
      send: (msg: FlowHostToCoordinator) => void;
      log: Logger;
      /** Overridable for tests only — production always gets the real
       * HASS_CALL_TIMEOUT_MS default. */
      hassCallTimeoutMs?: number;
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

    if (node.block.name === "@hass/action") {
      const call = req.inputs.call as ActionCall;
      const config = node.config as ActionConfig;
      return this.callHassAction(node.nodeId, config, call);
    }

    if (node.block.name === "@hass/read") {
      const config = node.config as ReadConfig;
      return this.callHassRead(node.nodeId, config.entity);
    }

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

  private callHassAction(
    nodeId: string,
    config: ActionConfig,
    call: ActionCall,
  ): Promise<undefined> {
    const requestId = this.nextActionRequestId++;
    const resolved: ActionCall = {
      ...call,
      target: call.target ?? config.target,
    };
    // Untyped, ad-hoc override read straight off the node's own wiring
    // config — deliberately not part of ActionConfig's type so
    // packages/runtime/src/hass/action.ts's public shape stays untouched.
    // See data/wiring/flowbun_test.json for the one node that sets it.
    const dryRunOverride = (config as { dryRun?: boolean }).dryRun;
    this.deps.send({
      type: "hass.action.call",
      requestId,
      nodeId,
      call: resolved,
      dryRunOverride,
    });
    const timeoutMs = this.deps.hassCallTimeoutMs ?? HASS_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(requestId);
        this.deps.log.error("hass.call_timeout", { node: nodeId });
        reject(
          new Error(
            `@hass/action call to "${nodeId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pendingActions.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private callHassRead(
    nodeId: string,
    entity: string,
  ): Promise<Record<string, unknown>> {
    const requestId = this.nextReadRequestId++;
    this.deps.send({
      type: "hass.read.call",
      requestId,
      nodeId,
      entity,
    });
    const timeoutMs = this.deps.hassCallTimeoutMs ?? HASS_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReads.delete(requestId);
        this.deps.log.error("hass.read_timeout", { node: nodeId, entity });
        reject(
          new Error(
            `@hass/read call to "${nodeId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pendingReads.set(requestId, {
        resolve: (reading) => {
          clearTimeout(timer);
          resolve({ result: reading });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
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

  handleReadResult(
    msg: Extract<CoordinatorToFlowHost, { type: "hass.read.result" }>,
  ): void {
    const pending = this.pendingReads.get(msg.requestId);
    if (!pending) return;
    this.pendingReads.delete(msg.requestId);
    if (msg.ok) {
      this.deps.log.info("hass.read", { entity: msg.reading.entity });
      pending.resolve(msg.reading);
    } else {
      this.deps.log.error("hass.read_failed", { error: msg.error });
      pending.reject(new Error(msg.error));
    }
  }

  handleActionResult(
    msg: Extract<CoordinatorToFlowHost, { type: "hass.action.result" }>,
  ): void {
    const pending = this.pendingActions.get(msg.requestId);
    if (!pending) return;
    this.pendingActions.delete(msg.requestId);
    if (msg.ok) {
      this.deps.log.info(msg.dryRun ? "hass.dry_run_call" : "hass.call", {});
      pending.resolve();
    } else {
      this.deps.log.error("hass.call_failed", { error: msg.error });
      pending.reject(new Error(msg.error));
    }
  }
}
