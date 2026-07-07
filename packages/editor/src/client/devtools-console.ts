import type { LogRecord } from "flowbun/ipc";

/**
 * Stage 2's hard requirement: every log/trace event dumped to the browser
 * devtools console, unconditionally — independent of whether any log-panel
 * UI is even mounted. Called directly from the socket reducer, not from a
 * component, so it can never be accidentally gated behind a render.
 */
export function logToDevtoolsConsole(entry: LogRecord): void {
  const prefix = `[${entry.flow}${entry.nodeId ? `/${entry.nodeId}` : ""}]`;
  const fn =
    entry.level === "error"
      ? console.error
      : entry.level === "warn"
        ? console.warn
        : entry.level === "debug"
          ? console.debug
          : console.info;
  fn(prefix, entry.msg, entry.meta ?? "");
}
