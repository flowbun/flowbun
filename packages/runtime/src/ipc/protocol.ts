import type { AgentCallKind, AnyAgentConfig } from "../ai/agent";
import type { ActionCall } from "../hass/action";
import type { EntityStateReading, HassEntitySummary } from "../hass/client";
import type { ExposedEntitySummary } from "../hass/exposed-entities";
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
  /** A piece of the agent's answer text, streamed while the agent.call
   * carrying the same requestId is still in flight — the flow-host emits it
   * on the calling node's `delta` output port (see DistributedExecutor.
   * handleAgentDelta) so a flow can start speaking/rendering before the
   * final agent.result lands. Ordering with agent.result is guaranteed by
   * the ipc channel; a delta arriving after its call settled is dropped. */
  | { type: "agent.delta"; requestId: number; text: string }
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
  /** Same borrowed-connection pattern as hass.entities.query, for one
   * entity's full current state — backs the chat/agent's `hass_get_state`
   * MCP tool. */
  | { type: "hass.state.query"; requestId: number; entity: string }
  /** And for the write side — backs the agent's `hass_call_service` MCP
   * tool. `dryRun` is decided coordinator-side (the process-wide
   * FLOWBUN_DRY_RUN, never overridable by the model — see coordinator's
   * agent/tools.ts) and passed through to performHassAction verbatim. */
  | {
      type: "hass.action.request";
      requestId: number;
      call: ActionCall;
      dryRun: boolean;
    }
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
      config: AnyAgentConfig;
      /** Which agent block this is — see AgentCallKind. Absent = "full". */
      agentKind?: AgentCallKind;
      /** Originating voice satellite's HA device id (from the input's
       * `meta`, which is otherwise held back from the relay — see
       * splitAgentInput) — the "hass" toolset's start_timer stamps it onto
       * new timers so timer_watchdog announces through the right speaker. */
      deviceId?: string;
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
  /** Reply to "hass.state.query" — `reading` is undefined for an entity HA
   * doesn't know (a valid answer, not an error). */
  | {
      type: "hass.state.result";
      requestId: number;
      ok: true;
      reading: EntityStateReading | undefined;
    }
  | { type: "hass.state.result"; requestId: number; ok: false; error: string }
  /** Reply to "hass.action.request". */
  | { type: "hass.action.result"; requestId: number; ok: true }
  | { type: "hass.action.result"; requestId: number; ok: false; error: string }
  | { type: "log"; entries: LogRecord[] }
  /** A node's WorkerManager has given up on it permanently (its respawn
   * budget is exhausted -- see worker-manager.ts's MAX_RESPAWNS) — unlike a
   * transient crash, nothing will bring this node back short of a whole
   * flow-host restart. Unsolicited, sent at most once per node per
   * flow-host lifetime. Surfaced by the supervisor as a "degraded"
   * FlowStatus rather than a new status kind, since the flow-host process
   * itself is still very much alive and running every other node fine. */
  | { type: "node.dead"; nodeId: string };

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
      config: AnyAgentConfig;
      /** See FlowHostToCoordinator's own agent.call — forwarded verbatim. */
      agentKind?: AgentCallKind;
      deviceId?: string;
    }
  | { type: "agent.cancelForFlow"; flowName: string }
  | { type: "shutdown" };

// ---------- ai-host -> coordinator (Bun.spawn ipc) ----------
export type AiHostToCoordinator =
  | { type: "ready" }
  | { type: "tool.call"; requestId: number; tool: string; args: unknown }
  /** Streamed answer text for an in-flight agent.call — relayed onward as
   * CoordinatorToFlowHost's own agent.delta (see its doc comment). */
  | { type: "agent.delta"; requestId: number; text: string }
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
  | { type: "terminate" }
  /** Reply to a Worker's own "hass.read" — see WorkerToFlowHost below. */
  | {
      type: "hass.read.result";
      requestId: number;
      reading: EntityStateReading | undefined;
    }
  /** Reply to a Worker's own "hass.call". */
  | { type: "hass.call.result"; requestId: number; ok: true }
  | { type: "hass.call.result"; requestId: number; ok: false; error: string }
  /** Reply to a Worker's own "hass.exposedEntities" — see
   * hass/exposed-entities.ts's own doc comment on why this never carries an
   * error variant (a failure degrades to an empty list instead). */
  | {
      type: "hass.exposedEntities.result";
      requestId: number;
      entities: ExposedEntitySummary[];
    };

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
  | { type: "event"; port: string; payload: unknown }
  /** A node's Worker has no Home Assistant connection of its own — the flow
   * owns exactly one, in the flow-host's main thread (see hass/client.ts's
   * setHassReadTransport doc comment). readEntityState() inside a Worker
   * relays through these two instead of calling getHass() directly;
   * worker-manager.ts answers using its own direct call into
   * flowbun/hass/client, then posts back "hass.read.result". */
  | { type: "hass.read"; requestId: number; entity: string }
  /** Same relay, for the write side (flowbun/hass/action's performHassAction). */
  | { type: "hass.call"; requestId: number; call: ActionCall; dryRun: boolean }
  /** Same relay, for flowbun/hass/exposed-entities's listExposedEntities. */
  | { type: "hass.exposedEntities"; requestId: number; assistant: string };
