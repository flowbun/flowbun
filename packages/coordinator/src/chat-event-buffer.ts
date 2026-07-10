import type { ChatEvent } from "flowbun/ws";

/**
 * Bounded in-memory ring buffer for the agent chat transcript, mirroring
 * log-buffer.ts exactly — same push/subscribe/all() shape, so ws-server.ts
 * wires it up identically to LogBuffer (see its own
 * `deps.logBuffer.subscribe(...)` line). Deliberately smaller capacity than
 * LogBuffer (500 vs 5000): a chat transcript accumulates far slower than
 * flow-host log/trace events. Not persisted — a coordinator restart loses
 * the visible transcript, same accepted gap as LogBuffer; the underlying
 * Claude Agent SDK session itself is separately resumable (see
 * agent/session-store.ts).
 */
export class ChatEventBuffer {
  private buf: ChatEvent[] = [];
  private listeners = new Set<(event: ChatEvent) => void>();
  private resetListeners = new Set<(events: readonly ChatEvent[]) => void>();

  constructor(private readonly capacity = 500) {}

  push(event: ChatEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity)
      this.buf.splice(0, this.buf.length - this.capacity);
    for (const listener of this.listeners) listener(event);
  }

  /** Wholesale replace — used when the coordinator's current chat session
   * changes (new or resumed session; see agent/runner.ts), not for
   * incremental turn-by-turn updates (that's push). Fires resetListeners,
   * not the per-event ones: this is a different kind of change (the whole
   * visible history moved, not one more event arrived) and gets its own
   * broadcast type (ws-server.ts's "chat.historyReset"). */
  replace(events: ChatEvent[]): void {
    this.buf = events.slice(-this.capacity);
    for (const listener of this.resetListeners) listener(this.buf);
  }

  subscribe(listener: (event: ChatEvent) => void): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: (event: ChatEvent) => void): void {
    this.listeners.delete(listener);
  }

  subscribeReset(listener: (events: readonly ChatEvent[]) => void): void {
    this.resetListeners.add(listener);
  }

  unsubscribeReset(listener: (events: readonly ChatEvent[]) => void): void {
    this.resetListeners.delete(listener);
  }

  all(): readonly ChatEvent[] {
    return this.buf;
  }
}
