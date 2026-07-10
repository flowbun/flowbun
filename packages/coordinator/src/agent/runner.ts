import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ChatSessionSummary } from "flowbun/ws";
import type { ChatEventBuffer } from "../chat-event-buffer";
import { translateSdkMessage } from "./events";
import { createAgentMcpServer } from "./mcp-server";
import {
  clearSessionId,
  findSessionTranscriptPath,
  listSessions as listSessionsFromDisk,
  readSessionId,
  writeSessionId,
} from "./session-store";
import { buildSystemPromptAppend } from "./system-prompt";
import type { AgentToolDeps } from "./tools";
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
  /** The coordinator's own tiny "last session id" pointer (session-store.ts),
   * separate from the SDK's own transcript storage. */
  sessionFile: string;
  maxTurns?: number;
}

/**
 * Owns the Claude Agent SDK's query() loop for flowbun's single, coordinator-
 * global chat conversation (see the plan's session-model rationale: nothing
 * else in this app has a per-user/per-connection concept, so neither does
 * this). One AgentRunner per coordinator process; `sendMessage` rejects
 * concurrent calls via a synchronously-set busy flag rather than queuing —
 * a message sent while the agent is still replying to a previous one is
 * simply refused, not queued.
 */
export function createAgentRunner(
  deps: AgentToolDeps,
  chatEvents: ChatEventBuffer,
  opts: AgentRunnerOptions,
  queryFn: QueryFn = query,
): AgentRunner {
  let busy = false;
  const mcpServer = createAgentMcpServer(deps);

  async function sendMessage(
    text: string,
    turnId: string,
    currentFlow?: string,
  ): Promise<void> {
    if (busy) {
      chatEvents.push({
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
    busy = true;
    try {
      // Proactive check, not a caught error from query() itself — more
      // reliable than pattern-matching a thrown message that could change
      // across SDK versions, and lets us give a precise, actionable
      // instruction instead of a generic failure. `claude setup-token`
      // prints a long-lived token for CLAUDE_CODE_OAUTH_TOKEN rather than
      // writing a credentials file when run non-interactively, so both
      // paths count as authenticated.
      const hasCredentialsFile = existsSync(
        join(opts.claudeConfigDir, ".credentials.json"),
      );
      const hasEnvToken = Boolean(
        Bun.env.CLAUDE_CODE_OAUTH_TOKEN || Bun.env.ANTHROPIC_API_KEY,
      );
      if (!hasCredentialsFile && !hasEnvToken) {
        chatEvents.push({
          kind: "turn.error",
          turnId,
          reason: "not_authenticated",
          message:
            "Claude isn't set up yet. Run once: ./scripts/setup-claude-auth.sh",
        });
        return;
      }

      chatEvents.push({ kind: "turn.started", turnId, at: Date.now() });

      const resumeId = readSessionId(opts.sessionFile);
      const stream = queryFn({
        prompt: text,
        options: {
          // Pinned and stable across every call in this deployment — the
          // SDK keys resumable sessions by this exact cwd string, so
          // resume silently fails to find anything if it ever drifts.
          cwd: deps.dataDir,
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
          // `result` — so a coordinator crash mid-turn still leaves a
          // resumable pointer (see the plan's failure-posture section).
          writeSessionId(opts.sessionFile, message.session_id);
        }
        for (const event of translateSdkMessage(message, turnId)) {
          chatEvents.push(event);
        }
      }
    } catch (err) {
      chatEvents.push({
        kind: "turn.error",
        turnId,
        reason: "other",
        message: String(err),
      });
    } finally {
      busy = false;
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
    // session. The caller (ws-server.ts) is responsible for pushing
    // `events` into the shared ChatEventBuffer/broadcast.
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
