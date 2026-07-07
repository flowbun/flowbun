import type { Logger } from "./block";

function line(
  level: string,
  msg: string,
  meta?: Record<string, unknown>,
): string {
  const entry = { level, msg, ...meta, t: new Date().toISOString() };
  return JSON.stringify(entry);
}

export function createConsoleLogger(): Logger {
  return {
    debug: (msg, meta) => console.debug(line("debug", msg, meta)),
    info: (msg, meta) => console.log(line("info", msg, meta)),
    warn: (msg, meta) => console.warn(line("warn", msg, meta)),
    error: (msg, meta) => console.error(line("error", msg, meta)),
  };
}

export interface TraceEntry {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
  at: number;
}

/** Wraps a base logger, additionally recording every call keyed by `meta.traceId` for later summary. */
export function createTracingLogger(base: Logger): {
  logger: Logger;
  traces: Map<string, TraceEntry[]>;
} {
  const traces = new Map<string, TraceEntry[]>();

  function record(level: string, msg: string, meta?: Record<string, unknown>) {
    const traceId = meta?.traceId;
    if (typeof traceId === "string") {
      const list = traces.get(traceId) ?? [];
      list.push({ level, msg, meta, at: Date.now() });
      traces.set(traceId, list);
    }
  }

  const logger: Logger = {
    debug(msg, meta) {
      record("debug", msg, meta);
      base.debug(msg, meta);
    },
    info(msg, meta) {
      record("info", msg, meta);
      base.info(msg, meta);
    },
    warn(msg, meta) {
      record("warn", msg, meta);
      base.warn(msg, meta);
    },
    error(msg, meta) {
      record("error", msg, meta);
      base.error(msg, meta);
    },
  };

  return { logger, traces };
}
