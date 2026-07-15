import type { AgentConfig } from "../ai/agent";
import type { HassEntitySummary } from "../hass/client";
import type { ChatEvent, ChatSessionSummary } from "../ws/protocol";

/** Mirrors coordinator's agent/tools.ts's ToolResult shape — duplicated here
 * (rather than imported, since coordinator isn't a dependency of runtime)
 * purely as the wire shape a "tool.call" reply carries. */
export interface AgentToolResult {
  ok: boolean;
  summary: string;
  error?: string;
}

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
  | { type: "flow.fireNode"; requestId: number; nodeId: string }
  | {
      type: "agent.result";
      requestId: number;
      ok: true;
      text: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { type: "agent.result"; requestId: number; ok: false; error: string }
  /** The coordinator no longer holds any HA connection of its own (see
   * hass/client.ts — each flow-host owns its own, independent one) — this
   * asks an arbitrary *running* flow-host to answer on its behalf, purely
   * for the editor's entity autocomplete and the chat/agent's
   * `hass_entities` MCP tool. See Supervisor.queryHassEntities(). */
  | { type: "hass.entities.query"; requestId: number }
  | { type: "shutdown" };

// ---------- flow-host -> coordinator (Bun.spawn ipc) ----------
export type FlowHostToCoordinator =
  | { type: "ready"; flow: string; nodeIds: string[] }
  | { type: "flow.fireNode.result"; requestId: number; ok: true }
  | {
      type: "flow.fireNode.result";
      requestId: number;
      ok: false;
      error: string;
    }
  | {
      type: "agent.call";
      requestId: number;
      nodeId: string;
      input: unknown;
      config: AgentConfig;
    }
  | {
      type: "hass.entities.result";
      requestId: number;
      ok: true;
      entities: HassEntitySummary[];
    }
  | {
      type: "hass.entities.result";
      requestId: number;
      ok: false;
      error: string;
    }
  | { type: "log"; entries: LogRecord[] };

// ---------- coordinator -> ai-host (Bun.spawn ipc) ----------
export type CoordinatorToAiHost =
  | { type: "tool.result"; requestId: number; result: AgentToolResult }
  | {
      /** Fire-and-forget, like ws-server.ts's own call into the (former)
       * in-process AgentRunner.sendMessage — ws-server.ts already replies
       * "chat.sendResult" to the browser immediately, before this is even
       * sent, and the real response streams back purely via "chat.event"
       * broadcasts (keyed by `turnId`, which the browser itself minted).
       * sendMessage() never throws — every failure becomes a pushed
       * ChatEvent — so no reply/correlation is needed for this message. */
      type: "chat.send";
      text: string;
      turnId: string;
      currentFlow?: string;
    }
  | { type: "chat.newSession"; requestId: number }
  | { type: "chat.listSessions"; requestId: number }
  | { type: "chat.resumeSession"; requestId: number; sessionId: string }
  | {
      type: "agent.call";
      requestId: number;
      flowName: string;
      nodeId: string;
      input: unknown;
      config: AgentConfig;
    }
  | { type: "agent.cancelForFlow"; flowName: string }
  | { type: "shutdown" };

// ---------- ai-host -> coordinator (Bun.spawn ipc) ----------
export type AiHostToCoordinator =
  | { type: "ready" }
  | { type: "tool.call"; requestId: number; tool: string; args: unknown }
  | { type: "chat.event"; event: ChatEvent }
  /** Mirrors AgentRunner's internal `busy` flag out to the coordinator, so
   * ws-server.ts's "chat.send" handler can keep doing its existing
   * synchronous isBusy() check inline (see ai-host-client.ts) instead of
   * needing an IPC round-trip — and so it can't race a send arriving just
   * as a turn starts/finishes. */
  | { type: "chat.busyChanged"; busy: boolean }
  | {
      type: "chat.newSessionResult";
      requestId: number;
      ok: boolean;
      error?: string;
    }
  | {
      type: "chat.sessionsResult";
      requestId: number;
      ok: true;
      sessions: ChatSessionSummary[];
    }
  | { type: "chat.sessionsResult"; requestId: number; ok: false; error: string }
  | {
      type: "chat.resumeSessionResult";
      requestId: number;
      ok: boolean;
      error?: string;
      events?: ChatEvent[];
    }
  | {
      type: "agent.result";
      requestId: number;
      ok: true;
      text: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { type: "agent.result"; requestId: number; ok: false; error: string };

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
    }
  /** Unsolicited — pushed at any time by a block's own `subscribe()` hook
   * (see block.ts), not in response to an `exec` request. `nodeId` is
   * stamped by the flow-host itself (see worker-manager.ts's `wire()`),
   * since a Worker only ever hosts one node and the block-authored `emit`
   * callback doesn't know its own nodeId. */
  | { type: "event"; port: string; payload: unknown };
