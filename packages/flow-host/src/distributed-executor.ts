import type {
  LoadedFlow,
  Logger,
  NodeExecutionRequest,
  NodeExecutor,
} from "flowbun";
import type { ActionCall, ActionConfig } from "flowbun/hass/action";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { WorkerManager } from "./worker-manager";

interface PendingAction {
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * The flow-host's NodeExecutor: ordinary nodes go to a persistent Worker
 * (WorkerManager); @hass/action nodes are relayed to the coordinator over
 * IPC instead of ever calling their process() — the coordinator is the only
 * process holding the real HA connection. @hass/trigger nodes never reach
 * execute() at all (no wire can target their empty inputs).
 */
export class DistributedExecutor implements NodeExecutor {
  private pendingActions = new Map<number, PendingAction>();
  private nextActionRequestId = 1;

  constructor(
    private readonly deps: {
      flow: LoadedFlow;
      workerManager: WorkerManager;
      send: (msg: FlowHostToCoordinator) => void;
      log: Logger;
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
    return new Promise((resolve, reject) => {
      this.pendingActions.set(requestId, {
        resolve: () => resolve(undefined),
        reject,
      });
    });
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
