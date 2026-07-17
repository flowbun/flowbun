import type { FlowStatus } from "flowbun/ws";

/** Also used by StatusDot for its hover tooltip — the one place a
 * compact, dot-only indicator still surfaces what the status actually is. */
export function label(status: FlowStatus): string {
  switch (status.kind) {
    case "starting":
      return "starting";
    case "running":
      return `running (pid ${status.pid})`;
    case "degraded":
      return `degraded: ${status.reason}`;
    case "restarting":
      return `restarting (attempt ${status.attempt})`;
    case "failed-typecheck":
      return status.stillRunning
        ? "typecheck failed (old flow still running)"
        : "typecheck failed";
    case "failed-load":
      return "failed to load (invalid wiring)";
    case "crash-looped":
      return `crash-looped (${status.attempts} attempts)`;
    case "disabled":
      return "disabled";
  }
}

function detail(status: FlowStatus): string | undefined {
  if (status.kind === "failed-typecheck" || status.kind === "failed-load")
    return status.output;
  return undefined;
}

export function FlowStatusBadge({ status }: { status: FlowStatus }) {
  return (
    <span
      className={`status-badge status-${status.kind}`}
      title={detail(status)}
    >
      <span className="status-dot" />
      {label(status)}
    </span>
  );
}
