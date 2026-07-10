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

  constructor(private readonly capacity = 500) {}

  push(event: ChatEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity)
      this.buf.splice(0, this.buf.length - this.capacity);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: ChatEvent) => void): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: (event: ChatEvent) => void): void {
    this.listeners.delete(listener);
  }

  all(): readonly ChatEvent[] {
    return this.buf;
  }
}
