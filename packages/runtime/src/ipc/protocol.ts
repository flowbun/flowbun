import type { ActionCall } from "../hass/action";
import type { TriggerOutputs } from "../hass/trigger";

/** One structured log/trace event, shaped for crossing process boundaries into the coordinator's ring buffer. */
export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
  at: number;
  flow: string;
  nodeId?: string;
}

// ---------- coordinator -> flow-host (Bun.spawn ipc) ----------
export type CoordinatorToFlowHost =
  | {
      type: "hass.event";
      nodeId: string;
      port: "changed";
      payload: TriggerOutputs["changed"];
      traceId?: string;
    }
  | { type: "hass.action.result"; requestId: number; ok: true; dryRun: boolean }
  | {
      type: "hass.action.result";
      requestId: number;
      ok: false;
      error: string;
      dryRun: boolean;
    }
  | { type: "shutdown" };

// ---------- flow-host -> coordinator (Bun.spawn ipc) ----------
export type FlowHostToCoordinator =
  | { type: "ready"; flow: string; nodeIds: string[] }
  | {
      type: "hass.subscribe";
      requestId: number;
      nodeId: string;
      entity: string;
    }
  | {
      type: "hass.action.call";
      requestId: number;
      nodeId: string;
      /** Already fully resolved (target merged in) by the flow-host before sending. */
      call: ActionCall;
      /** undefined means "defer to the coordinator's global isDryRun()". */
      dryRunOverride?: boolean;
    }
  | { type: "log"; entries: LogRecord[] };

// ---------- flow-host -> worker (postMessage, in-process thread boundary) ----------
export type FlowHostToWorker =
  | {
      type: "init";
      nodeId: string;
      flowName: string;
      blockModulePath: string;
      config: unknown;
      dbPath: string;
    }
  | {
      type: "exec";
      requestId: number;
      inputs: Record<string, unknown>;
      port: string;
      traceId: string;
      seq: number;
    }
  | { type: "terminate" };

// ---------- worker -> flow-host (postMessage) ----------
export type WorkerToFlowHost =
  | { type: "ready" }
  | { type: "init_error"; error: string }
  | { type: "result"; requestId: number; outputs?: Record<string, unknown> }
  | { type: "error"; requestId: number; error: string }
  | {
      type: "log";
      level: "debug" | "info" | "warn" | "error";
      msg: string;
      meta?: Record<string, unknown>;
    };
