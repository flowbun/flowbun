import type { ChatEvent } from "flowbun/ws";

export type ChatSegment =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      summary: string;
      done: boolean;
      ok?: boolean;
      error?: string;
    };

export interface ChatTurn {
  turnId: string;
  /** Only known for a turn this browser tab itself sent (see ChatPanel's
   * own sentText map) — chat.send's text is never echoed back as a
   * ChatEvent, so a turn seeded from a snapshot (page reload, or one
   * started from a different tab) has no way to recover it. */
  userText: string | undefined;
  segments: ChatSegment[];
  done: boolean;
  ok: boolean | undefined;
  error: { reason: string; message: string } | undefined;
}

/**
 * Folds the flat, append-only chatEvents stream into per-turn groups for
 * rendering — kept as a plain function (not a reducer case) since it's a
 * pure view derived from state that already lives in FlowbunSocketContext,
 * not state of its own.
 */
export function groupChatEvents(
  events: ChatEvent[],
  sentText: Map<string, string>,
): ChatTurn[] {
  const turns = new Map<string, ChatTurn>();
  const order: string[] = [];

  function turnFor(turnId: string): ChatTurn {
    let t = turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        userText: sentText.get(turnId),
        segments: [],
        done: false,
        ok: undefined,
        error: undefined,
      };
      turns.set(turnId, t);
      order.push(turnId);
    }
    return t;
  }

  for (const e of events) {
    const t = turnFor(e.turnId);
    switch (e.kind) {
      case "turn.started":
        break;
      case "assistant.text":
        t.segments.push({ kind: "text", text: e.text });
        break;
      case "tool.started":
        t.segments.push({
          kind: "tool",
          toolCallId: e.toolCallId,
          summary: e.summary,
          done: false,
        });
        break;
      case "tool.finished": {
        const seg = t.segments.find(
          (s): s is Extract<ChatSegment, { kind: "tool" }> =>
            s.kind === "tool" && s.toolCallId === e.toolCallId,
        );
        if (seg) {
          seg.done = true;
          seg.ok = e.ok;
          seg.error = e.error;
          // Deliberately keep tool.started's short label rather than
          // overwriting it with tool.finished's summary, which carries the
          // tool's full raw result text — fine for debugging but far too
          // long/verbose for a compact chat pill.
        }
        break;
      }
      case "turn.done":
        t.done = true;
        t.ok = e.ok;
        break;
      case "turn.error":
        t.done = true;
        t.ok = false;
        t.error = { reason: e.reason, message: e.message };
        break;
    }
  }

  return order.map((id) => turns.get(id) as ChatTurn);
}
