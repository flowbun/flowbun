import type { ChatEvent, ChatSessionSummary } from "flowbun/ws";
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePersistedState } from "../../hooks/usePersistedState";
import { useResizablePane } from "../../hooks/useResizablePane";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { ResizeHandle } from "../shared/ResizeHandle";
import { ChatMessage } from "./ChatMessage";
import { groupChatEvents } from "./groupChatEvents";

const MIN_WIDTH = 260;
const MAX_WIDTH = 640;

export function ChatPanel({
  chatEvents,
  open,
  onClose,
  currentFlow,
}: {
  chatEvents: ChatEvent[];
  /** Controls visibility via CSS, not mount/unmount — unmounting would
   * throw away sentTextRef below (this tab's only record of its own sent
   * prompts) every time the panel is closed and reopened. */
  open: boolean;
  onClose: () => void;
  /** The wiring file this tab currently has open in the canvas, if any —
   * sent along with every chat.send so the agent can resolve an ambiguous
   * "this flow"/"it" (see ws-server.ts's chat.send case). Read fresh at
   * send time, not tracked as its own state here. */
  currentFlow?: string | null;
}) {
  const { send, state } = useFlowbunSocket();
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const pane = useResizablePane("flowbun.chatPanelWidth", ref, {
    axis: "x",
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    invert: true,
  });
  const [input, setInput] = useState("");
  // Only this tab's own sent prompts are ever known — chat.send's text is
  // never echoed back as a broadcast ChatEvent (see groupChatEvents), so a
  // turn seeded from a reload or started in another tab renders without a
  // user bubble rather than guessing at one.
  const sentTextRef = useRef(new Map<string, string>());
  const entriesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  // Persisted so the dropdown still shows the right session selected after
  // a reload — there's no "currentSessionId" pushed from the server (see
  // the chat WS protocol), so without this a freshly loaded tab's dropdown
  // would show nothing selected even though a session is already active
  // underneath (the transcript itself already survives reload regardless,
  // via the server's own live buffer/snapshot — this only fixes the
  // dropdown's own memory of which one that was).
  const [currentSessionId, setCurrentSessionId] = usePersistedState(
    "flowbun.chatPanel.sessionId",
    "",
  );

  const turns = groupChatEvents(chatEvents, sentTextRef.current);
  const lastTurn = turns[turns.length - 1];
  const busy = lastTurn !== undefined && !lastTurn.done;

  // biome-ignore lint/correctness/useExhaustiveDependencies: turns.length is intentionally re-trigger-only — scrolls the DOM via entriesRef, not read directly, but must rerun whenever a new turn or event arrives.
  useEffect(() => {
    const el = entriesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatEvents.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSessions isn't in deps on purpose — re-declaring it every render and depending on it would re-fire this on every render instead of only on open/connect transitions.
  useEffect(() => {
    // Gated on state.connected, not just `open`: send() fires
    // wsRef.current?.send(...) even before the socket exists yet (still
    // awaiting the initial /config.json fetch) or while it's still
    // CONNECTING — that request then either silently vanishes (ref is
    // still null) or throws into an unhandled rejection (socket exists but
    // isn't OPEN), either way leaving `sessions` empty forever with no
    // retry. Since the chat panel now defaults to persisted-open, `open`
    // was already true on the very first render, well before the socket
    // finishes connecting — this used to fire straight into that race
    // every time. Re-running on every connected transition (including a
    // reconnect after a drop) means it retries once the socket is
    // genuinely usable, instead of only ever getting one doomed attempt.
    if (open && state.connected) refreshSessions();
  }, [open, state.connected]);

  async function refreshSessions() {
    const r = await send({
      type: "chat.listSessions",
      requestId: generateRequestId(),
    });
    if (r.type === "chat.sessionsResult" && r.ok) setSessions(r.sessions);
  }

  async function handleNewSession() {
    const r = await send({
      type: "chat.newSession",
      requestId: generateRequestId(),
    });
    if (r.type === "chat.newSessionResult" && r.ok) {
      setCurrentSessionId("");
      refreshSessions();
    } else if (r.type === "chat.newSessionResult") {
      console.error("failed to start a new chat session:", r.error);
    }
  }

  async function handleSelectSession(sessionId: string) {
    if (!sessionId) return;
    const r = await send({
      type: "chat.resumeSession",
      requestId: generateRequestId(),
      sessionId,
    });
    if (r.type === "chat.resumeSessionResult" && r.ok) {
      setCurrentSessionId(r.sessionId);
    } else if (r.type === "chat.resumeSessionResult") {
      console.error("failed to resume chat session:", r.error);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy) return;
    const requestId = generateRequestId();
    setInput("");
    const r = await send({
      type: "chat.send",
      requestId,
      text,
      currentFlow: currentFlow ?? undefined,
    });
    if (r.type === "chat.sendResult" && r.ok) {
      sentTextRef.current.set(requestId, text);
    } else {
      // Rejected (e.g. a race with another tab's message) — give the text
      // back rather than silently swallowing it.
      setInput(text);
    }
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div
      ref={ref}
      className={`chat-panel ${open ? "" : "chat-panel-hidden"}`}
      style={
        !isMobile && pane.size !== undefined ? { width: pane.size } : undefined
      }
    >
      {!isMobile && (
        <ResizeHandle
          orientation="vertical"
          pane={pane}
          label="Resize chat panel"
        />
      )}
      <div className="chat-panel-header">
        <span className="chat-panel-title">Chat with Claude</span>
        <button
          type="button"
          className="chat-panel-close"
          onClick={onClose}
          aria-label="Close chat"
          title="Close chat"
        >
          ✕
        </button>
      </div>
      <div className="chat-panel-session-bar">
        <select
          className="chat-panel-session-select"
          value={currentSessionId}
          onChange={(e) => handleSelectSession(e.target.value)}
          title="Resume a previous session"
        >
          <option value="">Resume a session…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="chat-panel-new-session"
          onClick={handleNewSession}
          title="Start a new session"
        >
          + New
        </button>
      </div>
      <div ref={entriesRef} className="chat-entries">
        {turns.length === 0 && (
          <div className="chat-hint">
            Ask Claude to create or modify flows and blocks — it can read the
            palette, wire nodes, and edit block source the same way the editor
            UI does. Every change it makes is typechecked, git-committed, and
            undoable, just like a change you make yourself.
          </div>
        )}
        {turns.map((t) => (
          <ChatMessage key={t.turnId} turn={t} />
        ))}
      </div>
      <textarea
        ref={inputRef}
        className="chat-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          busy
            ? "Claude is replying…"
            : "Ask Claude — Enter to send, Shift+Enter for a newline"
        }
        rows={2}
      />
    </div>
  );
}
