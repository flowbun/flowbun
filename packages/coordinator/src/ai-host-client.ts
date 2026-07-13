import { join } from "node:path";
import type { AgentConfig } from "flowbun/ai/agent";
import type { AiHostToCoordinator, CoordinatorToAiHost } from "flowbun/ipc";
import type { ChatEvent, ChatSessionSummary } from "flowbun/ws";
import { dispatchToolCall } from "./agent/dispatch-tool-call";
import type { AgentToolDeps } from "./agent/tools";
import type { ChatEventBuffer } from "./chat-event-buffer";

export type AgentCallResult =
  | {
      ok: true;
      text: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { ok: false; error: string };

export interface AiHostClient {
  isBusy(): boolean;
  /** Fire-and-forget — mirrors the (former) in-process
   * AgentRunner.sendMessage call: the browser's own "chat.sendResult" reply
   * happens immediately at the ws-server.ts call site, before this is even
   * sent, and the real response streams back purely via "chat.event"
   * broadcasts fed from this client's incoming messages. */
  sendChat(text: string, turnId: string, currentFlow?: string): void;
  newChatSession(): Promise<{ ok: boolean; error?: string }>;
  listChatSessions(): Promise<
    { ok: true; sessions: ChatSessionSummary[] } | { ok: false; error: string }
  >;
  resumeChatSession(sessionId: string): Promise<{
    ok: boolean;
    error?: string;
    events?: ChatEvent[];
  }>;
  callAgent(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AgentConfig,
  ): Promise<AgentCallResult>;
  cancelForFlow(flowName: string): void;
  stop(): void;
}

/** The subprocess side of the channel — deliberately just a `send`, so
 * tests can inject a fake one and drive `onMessage` directly rather than
 * spawning a real ai-host process (mirrors distributed-executor.test.ts's
 * own fake `send` for the flow-host<->coordinator IPC boundary). */
export type AiHostChannel = { send: (msg: CoordinatorToAiHost) => void };

/** Real production implementation — spawns the one, app-global ai-host
 * subprocess (mirrors Supervisor's own Bun.spawn shape for flow-hosts, just
 * a single persistent instance rather than one per flow). */
export function spawnAiHost(
  dataDir: string,
  onMessage: (msg: AiHostToCoordinator) => void,
): AiHostChannel {
  const mainPath = join(
    import.meta.dir,
    "..",
    "..",
    "ai-host",
    "src",
    "main.ts",
  );
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", mainPath],
    env: { ...Bun.env, FLOWBUN_DATA_DIR: dataDir },
    ipc: (message) => onMessage(message as AiHostToCoordinator),
    stdio: ["ignore", "inherit", "inherit"],
  });
  return { send: (msg) => subprocess.send(msg) };
}

export interface AiHostClientOptions {
  dataDir: string;
  deps: AgentToolDeps;
  chatEvents: ChatEventBuffer;
  /** Overridable for tests only — production always spawns the real
   * ai-host subprocess via spawnAiHost. */
  spawn?: (
    dataDir: string,
    onMessage: (msg: AiHostToCoordinator) => void,
  ) => AiHostChannel;
}

/**
 * Relays every Claude Agent SDK interaction — interactive chat and every
 * flow's @ai/agent calls — to the ai-host process over IPC. This coordinator
 * process itself never touches the Claude Agent SDK, session storage, or
 * credentials directly; its role here is pure relay/coordination, running
 * the actual `flowbun` MCP tool handlers (dispatchToolCall, against the
 * coordinator's own real state) when ai-host asks it to.
 */
export function createAiHostClient(opts: AiHostClientOptions): AiHostClient {
  let busy = false;
  let nextRequestId = 1;
  const pendingNewSession = new Map<
    number,
    (r: { ok: boolean; error?: string }) => void
  >();
  const pendingListSessions = new Map<
    number,
    (
      r:
        | { ok: true; sessions: ChatSessionSummary[] }
        | { ok: false; error: string },
    ) => void
  >();
  const pendingResumeSession = new Map<
    number,
    (r: { ok: boolean; error?: string; events?: ChatEvent[] }) => void
  >();
  const pendingAgentCalls = new Map<number, (r: AgentCallResult) => void>();

  const channel = (opts.spawn ?? spawnAiHost)(opts.dataDir, (msg) =>
    onMessage(msg),
  );

  function send(msg: CoordinatorToAiHost): void {
    channel.send(msg);
  }

  function onMessage(msg: AiHostToCoordinator): void {
    switch (msg.type) {
      case "ready":
        break;
      case "tool.call": {
        dispatchToolCall(opts.deps, msg.tool, msg.args).then((result) => {
          send({ type: "tool.result", requestId: msg.requestId, result });
        });
        break;
      }
      case "chat.event":
        opts.chatEvents.push(msg.event);
        break;
      case "chat.busyChanged":
        busy = msg.busy;
        break;
      case "chat.newSessionResult": {
        const resolve = pendingNewSession.get(msg.requestId);
        if (!resolve) break;
        pendingNewSession.delete(msg.requestId);
        resolve({ ok: msg.ok, error: msg.error });
        break;
      }
      case "chat.sessionsResult": {
        const resolve = pendingListSessions.get(msg.requestId);
        if (!resolve) break;
        pendingListSessions.delete(msg.requestId);
        resolve(
          msg.ok
            ? { ok: true, sessions: msg.sessions }
            : { ok: false, error: msg.error },
        );
        break;
      }
      case "chat.resumeSessionResult": {
        const resolve = pendingResumeSession.get(msg.requestId);
        if (!resolve) break;
        pendingResumeSession.delete(msg.requestId);
        resolve({ ok: msg.ok, error: msg.error, events: msg.events });
        break;
      }
      case "agent.result": {
        const resolve = pendingAgentCalls.get(msg.requestId);
        if (!resolve) break;
        pendingAgentCalls.delete(msg.requestId);
        resolve(
          msg.ok
            ? {
                ok: true,
                text: msg.text,
                costUsd: msg.costUsd,
                durationMs: msg.durationMs,
                numTurns: msg.numTurns,
              }
            : { ok: false, error: msg.error },
        );
        break;
      }
    }
  }

  function newChatSession(): Promise<{ ok: boolean; error?: string }> {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pendingNewSession.set(requestId, resolve);
      send({ type: "chat.newSession", requestId });
    });
  }

  function listChatSessions(): Promise<
    { ok: true; sessions: ChatSessionSummary[] } | { ok: false; error: string }
  > {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pendingListSessions.set(requestId, resolve);
      send({ type: "chat.listSessions", requestId });
    });
  }

  function resumeChatSession(sessionId: string): Promise<{
    ok: boolean;
    error?: string;
    events?: ChatEvent[];
  }> {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pendingResumeSession.set(requestId, resolve);
      send({ type: "chat.resumeSession", requestId, sessionId });
    });
  }

  function callAgent(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AgentConfig,
  ): Promise<AgentCallResult> {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pendingAgentCalls.set(requestId, resolve);
      send({ type: "agent.call", requestId, flowName, nodeId, input, config });
    });
  }

  function cancelForFlow(flowName: string): void {
    send({ type: "agent.cancelForFlow", flowName });
  }

  function stop(): void {
    send({ type: "shutdown" });
  }

  return {
    isBusy: () => busy,
    sendChat: (text, turnId, currentFlow) =>
      send({ type: "chat.send", text, turnId, currentFlow }),
    newChatSession,
    listChatSessions,
    resumeChatSession,
    callAgent,
    cancelForFlow,
    stop,
  };
}
