import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ChatSessionSummary } from "flowbun/ws";
import { hasClaudeCredentials } from "./auth";
import { translateSdkMessage } from "./events";
import { createAgentMcpServer, type ToolCaller } from "./mcp-server";
import {
  clearSessionId,
  findSessionTranscriptPath,
  listSessions as listSessionsFromDisk,
  readSessionId,
  writeSessionId,
} from "./session-store";
import { buildSystemPromptAppend } from "./system-prompt";
import { replaySessionTranscript } from "./transcript";

export interface AgentRunner {
  /** Never throws/rejects — every failure is communicated via a pushed
   * ChatEvent, not a thrown error, so callers never need a try/catch (an
   * attached `.catch()` at the call site is defense in depth only).
   * `currentFlow`, if given, is the wiring file the sending browser tab
   * currently has open in the canvas — folded into this turn's system
   * prompt (see system-prompt.ts's buildSystemPromptAppend), not persisted
   * as part of the conversation. */
  sendMessage(
    text: string,
    turnId: string,
    currentFlow?: string,
  ): Promise<void>;
  isBusy(): boolean;
  /** Every session this app has ever had, newest-used first — sourced from
   * the SDK's own on-disk transcripts (session-store.ts's listSessions). */
  listSessions(): ChatSessionSummary[];
  /** Clears the current-session pointer so the *next* sendMessage omits
   * `resume` entirely and the SDK mints a fresh session id. Rejects while
   * busy, same guard as sendMessage. */
  startNewSession(): { ok: boolean; error?: string };
  /** Points the current-session pointer at an existing session and replays
   * its transcript for the caller to broadcast. Rejects while busy. */
  resumeSession(sessionId: string): {
    ok: boolean;
    error?: string;
    events?: ChatEvent[];
  };
}

type QueryFn = typeof query;

export interface AgentRunnerOptions {
  /** CLAUDE_CONFIG_DIR — where the SDK's own .credentials.json and session
   * transcripts live. */
  claudeConfigDir: string;
  /** ai-host's own tiny "last session id" pointer (session-store.ts),
   * separate from the SDK's own transcript storage. */
  sessionFile: string;
  /** Pinned and stable across every call in this deployment — the SDK keys
   * resumable sessions by this exact cwd string, so resume silently fails
   * to find anything if it ever drifts. */
  cwd: string;
  maxTurns?: number;
}

/**
 * Owns the Claude Agent SDK's query() loop for flowbun's single, app-global
 * chat conversation (nothing else in this app has a per-user/per-connection
 * concept, so neither does this). One AgentRunner per ai-host process;
 * `sendMessage` rejects concurrent calls via a synchronously-set busy flag
 * rather than queuing — a message sent while the agent is still replying to
 * a previous one is simply refused, not queued. Deliberately separate from
 * flow-node agent calls (node-agent.ts), which never share this session or
 * this busy flag — a flow firing an @ai/agent node can't block, or be
 * blocked by, an interactive chat turn.
 */
export function createAgentRunner(
  opts: AgentRunnerOptions,
  callTool: ToolCaller,
  onEvent: (event: ChatEvent) => void,
  onBusyChange: (busy: boolean) => void,
  queryFn: QueryFn = query,
): AgentRunner {
  let busy = false;

  function setBusy(next: boolean): void {
    busy = next;
    onBusyChange(next);
  }

  async function sendMessage(
    text: string,
    turnId: string,
    currentFlow?: string,
  ): Promise<void> {
    if (busy) {
      onEvent({
        kind: "turn.error",
        turnId,
        reason: "other",
        message: "agent is already handling a previous message",
      });
      return;
    }
    // Set synchronously, before any await, so a second sendMessage() call
    // arriving before this one's first await point still sees busy=true —
    // race-free under Bun's run-to-completion semantics for sync code.
    setBusy(true);
    try {
      if (!hasClaudeCredentials(opts.claudeConfigDir)) {
        onEvent({
          kind: "turn.error",
          turnId,
          reason: "not_authenticated",
          message:
            "Claude isn't set up yet. Run once: ./scripts/setup-claude-auth.sh",
        });
        return;
      }

      onEvent({ kind: "turn.started", turnId, at: Date.now() });

      const resumeId = readSessionId(opts.sessionFile);
      // A fresh MCP-tool-calling wrapper per turn — cheap (closures over a
      // stable callTool), and avoids ever reusing one McpServer instance
      // across two connected query() calls (see mcp-server.ts's own
      // comment: a shared instance throws "Already connected to a
      // transport" on the second concurrent use).
      const mcpServer = createAgentMcpServer(callTool);
      const stream = queryFn({
        prompt: text,
        options: {
          cwd: opts.cwd,
          // Disables every built-in SDK tool (Bash, Read, Write, Edit,
          // WebSearch, ...) — the "flowbun" MCP server below is this
          // agent's entire capability surface.
          tools: [],
          mcpServers: { flowbun: mcpServer },
          allowedTools: ["mcp__flowbun__*"],
          maxTurns: opts.maxTurns ?? 10,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildSystemPromptAppend(currentFlow),
          },
          resume: resumeId,
        },
      });

      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          // Persisted as soon as it's first seen, not only at a clean
          // `result` — so an ai-host crash mid-turn still leaves a
          // resumable pointer.
          writeSessionId(opts.sessionFile, message.session_id);
        }
        for (const event of translateSdkMessage(message, turnId)) {
          onEvent(event);
        }
      }
    } catch (err) {
      onEvent({
        kind: "turn.error",
        turnId,
        reason: "other",
        message: String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  function listSessions(): ChatSessionSummary[] {
    return listSessionsFromDisk(opts.claudeConfigDir);
  }

  function startNewSession(): { ok: boolean; error?: string } {
    if (busy) {
      return {
        ok: false,
        error: "agent is still responding to a previous message",
      };
    }
    clearSessionId(opts.sessionFile);
    return { ok: true };
  }

  function resumeSession(sessionId: string): {
    ok: boolean;
    error?: string;
    events?: ChatEvent[];
  } {
    if (busy) {
      return {
        ok: false,
        error: "agent is still responding to a previous message",
      };
    }
    const path = findSessionTranscriptPath(opts.claudeConfigDir, sessionId);
    if (!path) {
      return {
        ok: false,
        error: `no transcript found for session "${sessionId}"`,
      };
    }
    let events: ChatEvent[];
    try {
      events = replaySessionTranscript(readFileSync(path, "utf8"));
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    // Only the pointer changes here — the next sendMessage resumes this
    // session. The caller is responsible for broadcasting `events`.
    writeSessionId(opts.sessionFile, sessionId);
    return { ok: true, events };
  }

  return {
    sendMessage,
    isBusy: () => busy,
    listSessions,
    startNewSession,
    resumeSession,
  };
}
