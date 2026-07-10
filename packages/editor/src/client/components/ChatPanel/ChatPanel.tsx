import type { ChatEvent } from "flowbun/ws";
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
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
}: {
  chatEvents: ChatEvent[];
  /** Controls visibility via CSS, not mount/unmount — unmounting would
   * throw away sentTextRef below (this tab's only record of its own sent
   * prompts) every time the panel is closed and reopened. */
  open: boolean;
  onClose: () => void;
}) {
  const { send } = useFlowbunSocket();
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

  const turns = groupChatEvents(chatEvents, sentTextRef.current);
  const lastTurn = turns[turns.length - 1];
  const busy = lastTurn !== undefined && !lastTurn.done;

  // biome-ignore lint/correctness/useExhaustiveDependencies: turns.length is intentionally re-trigger-only — scrolls the DOM via entriesRef, not read directly, but must rerun whenever a new turn or event arrives.
  useEffect(() => {
    const el = entriesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatEvents.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy) return;
    const requestId = generateRequestId();
    setInput("");
    const r = await send({ type: "chat.send", requestId, text });
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
