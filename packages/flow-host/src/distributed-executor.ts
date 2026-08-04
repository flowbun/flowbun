import type {
  LoadedFlow,
  Logger,
  NodeExecutionRequest,
  NodeExecutor,
} from "flowbun";
import type { AgentCallKind, AnyAgentConfig } from "flowbun/ai/agent";
import { splitAgentInput } from "flowbun/ai/agent";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { WorkerManager } from "./worker-manager";

// A margin over ai-host's own internal per-call timeout (see
// packages/ai-host/src/agent/node-agent.ts), not the primary timeout itself
// — the coordinator's relayed reply normally arrives well before this fires,
// carrying a specific "timed out after Nms" error. This is only a backstop
// against total silence (coordinator or ai-host process hung/crashed).
const AGENT_CALL_TIMEOUT_MARGIN_MS = 15_000;

// WorkerManager's own WORKER_EXEC_TIMEOUT_MS (10s) is a hard kill-and-respawn
// ceiling applied to every ordinary node's exec() call — fine for the vast
// majority of blocks, which never come close to it, but a real problem for
// any block whose own legitimate work can take longer (network calls to a
// slow endpoint) and that already exposes its own configurable `timeoutMs`.
// Without an override, WorkerManager would silently kill and respawn that
// node's Worker at exactly 10s regardless of what the block's own config
// says — discarding an in-flight, possibly-about-to-succeed response — and
// three such kills within WorkerManager's own 60s window (MAX_RESPAWNS)
// permanently marks the node dead. So: any non-relay node whose resolved
// config has a numeric `timeoutMs` field gets that value (plus this margin,
// mirroring AGENT_CALL_TIMEOUT_MARGIN_MS's identical reasoning for the relay
// path above) passed through as WorkerManager's own per-call override
// instead of the blind default — the block's own internal budget becomes
// the real one, and WorkerManager's timer is purely a backstop against total
// silence. Every other block's config has no field by that exact name, so
// this is a no-op for them.
const WORKER_TIMEOUT_MARGIN_MS = 2_000;

interface PendingAgentCall {
  resolve: (result: {
    text: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
  }) => void;
  reject: (e: Error) => void;
  /** For routing streamed agent.delta messages (see handleAgentDelta) back
   * to the calling node's `delta` port, with the held-back `meta` echo
   * re-attached exactly like the final result gets it. */
  nodeId: string;
  meta: unknown;
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
 * reaches execute() here either. A `kind: "relay"` block (only @ai/agent
 * today) is relayed to the coordinator over IPC instead of ever calling its
 * process(): the coordinator (and, onward from there, the dedicated ai-host
 * process) is the only place holding Claude credentials/session state.
 * @core/scheduler never reaches execute() at all (no wire can target its
 * empty inputs).
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
      /** Emits a streamed agent delta on a relay node's `delta` output port
       * — wired by main.ts to router.emitFromSource, the same out-of-band
       * entry point a subscribing block's Worker events use. Optional only
       * for tests that never stream. */
      emitDelta?: (nodeId: string, payload: Record<string, unknown>) => void;
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

    if (node.block.kind === "relay") {
      const config = node.config as AnyAgentConfig;
      // Which relay flavor rides in the block name — the ai-host builds a
      // restricted hass-only session for @ai/agent-hass (see AgentCallKind).
      const agentKind: AgentCallKind =
        node.block.name === "@ai/agent-hass" ? "hass" : "full";
      return this.callAgent(node.nodeId, config, req.inputs.prompt, agentKind);
    }

    const requestId = this.deps.workerManager.allocRequestId();
    const configTimeoutMs = (node.config as { timeoutMs?: unknown }).timeoutMs;
    return this.deps.workerManager.exec(node.nodeId, requestId, {
      inputs: req.inputs,
      port: req.port,
      traceId: req.traceId,
      seq: req.seq,
      timeoutMs:
        typeof configTimeoutMs === "number"
          ? configTimeoutMs + WORKER_TIMEOUT_MARGIN_MS
          : undefined,
    });
  }

  private callAgent(
    nodeId: string,
    config: AnyAgentConfig,
    input: unknown,
    agentKind: AgentCallKind,
  ): Promise<Record<string, unknown>> {
    // `meta` is correlation state for the wires AROUND this node (e.g.
    // @http/in's requestId riding through to the reply), not part of the
    // prompt — held back here and re-attached to the result below, so the
    // model never sees it and the ai-host never has to know it exists. See
    // splitAgentInput's own doc comment for the exact input convention.
    const { forwarded, meta } = splitAgentInput(input);
    // The one meta field the relay DOES forward: the originating satellite's
    // device id, which the hass toolset's start_timer needs (mirrors how
    // @ai/openai_agent reads it out of the same meta in-process).
    const deviceId =
      typeof meta === "object" &&
      meta !== null &&
      typeof (meta as { deviceId?: unknown }).deviceId === "string"
        ? (meta as { deviceId: string }).deviceId
        : undefined;
    const requestId = this.nextAgentRequestId++;
    this.deps.send({
      type: "agent.call",
      requestId,
      nodeId,
      input: forwarded,
      config,
      agentKind,
      ...(deviceId === undefined ? {} : { deviceId }),
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
          resolve({
            result: meta === undefined ? result : { ...result, meta },
          });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        nodeId,
        meta,
      });
    });
  }

  /** Emits one streamed answer piece on the calling node's `delta` port —
   * only while its agent.call is still pending, so a delta racing the final
   * result/timeout is silently dropped (matching the http/in chunk race's
   * own semantics downstream). */
  handleAgentDelta(
    msg: Extract<CoordinatorToFlowHost, { type: "agent.delta" }>,
  ): void {
    const pending = this.pendingAgentCalls.get(msg.requestId);
    if (!pending || !this.deps.emitDelta) return;
    this.deps.emitDelta(pending.nodeId, {
      text: msg.text,
      ...(pending.meta === undefined ? {} : { meta: pending.meta }),
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
