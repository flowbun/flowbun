import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentToolResult,
  AiHostToCoordinator,
  CoordinatorToAiHost,
} from "flowbun/ipc";
import type { ToolCaller } from "./agent/mcp-server";
import { createAgentNodeCaller } from "./agent/node-agent";
import { createAgentRunner } from "./agent/runner";

const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");

function send(msg: AiHostToCoordinator): void {
  (process as unknown as { send?: (m: unknown) => void }).send?.(msg);
}

async function main(): Promise<void> {
  // Separate from data/blocks|wiring|state|generated — holds Claude's own
  // OAuth credentials/session transcripts (CLAUDE_CONFIG_DIR) and this
  // process's own session-id pointer. Excluded from the git-snapshot repo
  // via data/.gitignore's "agent/" entry (these are secrets).
  const agentDir = join(DATA_DIR, "agent");
  mkdirSync(agentDir, { recursive: true });
  const claudeConfigDir =
    Bun.env.CLAUDE_CONFIG_DIR ?? join(agentDir, "claude-home");
  const sessionFile = join(agentDir, "session.json");

  let nextToolRequestId = 1;
  const pendingToolCalls = new Map<
    number,
    { resolve: (r: AgentToolResult) => void }
  >();

  const callTool: ToolCaller = (tool, args) => {
    const requestId = nextToolRequestId++;
    return new Promise<AgentToolResult>((resolve) => {
      pendingToolCalls.set(requestId, { resolve });
      send({ type: "tool.call", requestId, tool, args });
    });
  };

  const agentRunner = createAgentRunner(
    {
      claudeConfigDir,
      sessionFile,
      cwd: DATA_DIR,
      maxTurns: Bun.env.FLOWBUN_AGENT_MAX_TURNS
        ? Number(Bun.env.FLOWBUN_AGENT_MAX_TURNS)
        : undefined,
    },
    callTool,
    (event) => send({ type: "chat.event", event }),
    (busy) => send({ type: "chat.busyChanged", busy }),
  );

  const agentNodeCaller = createAgentNodeCaller(
    {
      claudeConfigDir,
      cwd: DATA_DIR,
      stallTimeoutMs: Bun.env.FLOWBUN_AGENT_STALL_TIMEOUT_MS
        ? Number(Bun.env.FLOWBUN_AGENT_STALL_TIMEOUT_MS)
        : undefined,
    },
    callTool,
  );

  process.on("message", (raw: unknown) => {
    const msg = raw as CoordinatorToAiHost;
    switch (msg.type) {
      case "tool.result": {
        const pending = pendingToolCalls.get(msg.requestId);
        if (!pending) break;
        pendingToolCalls.delete(msg.requestId);
        pending.resolve(msg.result);
        break;
      }
      case "chat.send": {
        // Never throws — every failure becomes a pushed "chat.event"
        // (turn.error) instead; this .catch() is defense in depth only.
        agentRunner
          .sendMessage(msg.text, msg.turnId, msg.currentFlow)
          .catch((err) => {
            send({
              type: "chat.event",
              event: {
                kind: "turn.error",
                turnId: msg.turnId,
                reason: "other",
                message: String(err),
              },
            });
          });
        break;
      }
      case "chat.newSession": {
        const r = agentRunner.startNewSession();
        send({
          type: "chat.newSessionResult",
          requestId: msg.requestId,
          ok: r.ok,
          error: r.error,
        });
        break;
      }
      case "chat.listSessions": {
        try {
          const sessions = agentRunner.listSessions();
          send({
            type: "chat.sessionsResult",
            requestId: msg.requestId,
            ok: true,
            sessions,
          });
        } catch (err) {
          send({
            type: "chat.sessionsResult",
            requestId: msg.requestId,
            ok: false,
            error: String(err),
          });
        }
        break;
      }
      case "chat.resumeSession": {
        const r = agentRunner.resumeSession(msg.sessionId);
        send({
          type: "chat.resumeSessionResult",
          requestId: msg.requestId,
          ok: r.ok,
          error: r.error,
          events: r.events,
        });
        break;
      }
      case "agent.call": {
        agentNodeCaller
          .call(msg.flowName, msg.nodeId, msg.input, msg.config)
          .then((result) => {
            send({ type: "agent.result", requestId: msg.requestId, ...result });
          });
        break;
      }
      case "agent.cancelForFlow": {
        agentNodeCaller.cancelForFlow(msg.flowName);
        break;
      }
      case "shutdown": {
        process.exit(0);
        break;
      }
    }
  });

  send({ type: "ready" });
  console.log("[ai-host] ready", { pid: process.pid });

  process.on("SIGTERM", () => process.exit(0));
}

main().catch((err) => {
  console.error("[ai-host] fatal:", err);
  process.exit(1);
});
