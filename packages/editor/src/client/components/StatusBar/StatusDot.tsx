import type { FlowStatus } from "flowbun/ws";
import { label } from "./FlowStatusBadge";

/**
 * Just the colored dot from FlowStatusBadge, without the text label — used
 * in the flow tab bar where space is tight (the full label moved into
 * FlowDetailModal), but an at-a-glance running/starting/failed signal is
 * still worth keeping visible. Reuses the exact same status-{kind} CSS
 * classes FlowStatusBadge's dot relies on, just without the pill/padding
 * styling around it.
 */
export function StatusDot({ status }: { status: FlowStatus }) {
  return (
    <span
      className={`status-dot-wrap status-${status.kind}`}
      title={label(status)}
    >
      <span className="status-dot" />
    </span>
  );
}
