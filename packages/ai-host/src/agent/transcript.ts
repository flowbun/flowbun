import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "flowbun/ws";
import { translateSdkMessage } from "./events";

/**
 * Parses and replays one session's on-disk `.jsonl` transcript (written by
 * the Claude Agent SDK itself under `$CLAUDE_CONFIG_DIR/projects/<cwd>/
 * <sessionId>.jsonl`) into the same ChatEvent shape live streaming produces
 * — confirmed against a real transcript this session (see the plan's
 * Context section for the exact findings):
 *
 * - Every line is one record; `record.type` includes CLI-internal
 *   bookkeeping types ("queue-operation", "ai-title", "last-prompt", "mode")
 *   that aren't SDKMessages at all — anything other than "user"/"assistant"
 *   is dropped outright, not passed to translateSdkMessage.
 * - No "system"/"result" records are ever persisted — there is no on-disk
 *   source for turn-completion status, so a synthetic turn.done{ok:true} is
 *   emitted for each turn once it's over, purely so groupChatEvents' `done`
 *   flag is true (otherwise the chat input stays disabled after loading
 *   history — there's no real "still in progress" state for the past).
 * - A genuine new user prompt (a "user" record whose content contains a
 *   `text` block) carries a fresh `promptId`; everything belonging to that
 *   same agentic turn (assistant thinking/tool_use, the "user"-typed
 *   tool_result records relaying results back) reuses it — a ready-made,
 *   on-disk turn-boundary key.
 */
export function replaySessionTranscript(jsonlText: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  let currentTurnId: string | undefined;
  let turnHasContent = false;

  function closeTurn(): void {
    if (currentTurnId && turnHasContent) {
      events.push({ kind: "turn.done", turnId: currentTurnId, ok: true });
    }
  }

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;

    if (record.type === "user") {
      const content = (record as { message?: { content?: unknown } }).message
        ?.content;
      const startsNewTurn =
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string })?.type === "text") &&
        typeof record.promptId === "string" &&
        record.promptId !== currentTurnId;
      if (startsNewTurn) {
        closeTurn();
        currentTurnId = record.promptId as string;
        turnHasContent = false;
      }
    }

    if (!currentTurnId) continue; // no genuine user prompt seen yet — nothing to attribute this record to
    const translated = translateSdkMessage(
      record as SDKMessage,
      currentTurnId,
      { includeUserText: true },
    );
    if (translated.length) turnHasContent = true;
    events.push(...translated);
  }

  closeTurn();
  return events;
}
