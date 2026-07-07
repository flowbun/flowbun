import type { FlowStatus } from "flowbun/ws";

function label(status: FlowStatus): string {
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
    case "crash-looped":
      return `crash-looped (${status.attempts} attempts)`;
  }
}

function detail(status: FlowStatus): string | undefined {
  if (status.kind === "failed-typecheck") return status.output;
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
