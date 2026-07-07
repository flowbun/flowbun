import type { LogRecord } from "flowbun/ipc";

/**
 * Bounded in-memory ring buffer for structured log/trace events forwarded
 * from flow-hosts. 5000 entries comfortably covers many hours of history at
 * realistic home-automation event rates. No persistence yet, no consumer
 * beyond this process yet — Phase 3's websocket layer reads from this.
 */
export class LogBuffer {
  private buf: LogRecord[] = [];

  constructor(private readonly capacity = 5000) {}

  push(entry: LogRecord): void {
    this.buf.push(entry);
    if (this.buf.length > this.capacity)
      this.buf.splice(0, this.buf.length - this.capacity);
  }

  all(): readonly LogRecord[] {
    return this.buf;
  }

  forFlow(flow: string): LogRecord[] {
    return this.buf.filter((e) => e.flow === flow);
  }

  forTrace(traceId: string): LogRecord[] {
    return this.buf.filter((e) => e.meta?.traceId === traceId);
  }
}
