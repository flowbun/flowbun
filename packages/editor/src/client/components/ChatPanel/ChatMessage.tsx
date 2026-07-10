import type { ChatTurn } from "./groupChatEvents";

export function ChatMessage({ turn }: { turn: ChatTurn }) {
  return (
    <div className="chat-turn">
      {turn.userText !== undefined && (
        <div className="chat-bubble chat-bubble-user">{turn.userText}</div>
      )}
      {turn.segments.map((seg, i) =>
        seg.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no stable id, this is an append-only render of one immutable turn's history
          <div key={i} className="chat-bubble chat-bubble-assistant">
            {seg.text}
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: segments have no stable id, this is an append-only render of one immutable turn's history
            key={i}
            className={`chat-tool-call ${seg.done ? (seg.ok ? "ok" : "error") : "pending"}`}
          >
            <span className="chat-tool-call-icon">
              {seg.done ? (seg.ok ? "✓" : "✗") : "…"}
            </span>
            <span className="chat-tool-call-summary">{seg.summary}</span>
            {seg.error && (
              <span className="chat-tool-call-error">{seg.error}</span>
            )}
          </div>
        ),
      )}
      {turn.error && (
        <div className="chat-bubble chat-bubble-error">
          {turn.error.message}
        </div>
      )}
    </div>
  );
}
