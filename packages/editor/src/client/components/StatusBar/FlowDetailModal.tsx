import type { FlowEntry } from "flowbun/ws";
import { useState } from "react";
import { createPortal } from "react-dom";
import { FlowStatusBadge } from "./FlowStatusBadge";

/**
 * Opened by double-clicking a flow tab. Status used to live inline on the
 * tab itself (a FlowStatusBadge next to the name) — moved here instead, so
 * the tab bar stays compact and a failed-typecheck flow's full output (only
 * ever a tooltip before) gets room to actually be read.
 */
export function FlowDetailModal({
  entry,
  onClose,
  onToggleDisabled,
}: {
  entry: FlowEntry;
  onClose: () => void;
  /** Flips the whole flow's `disabled` flag — unlike a node's own disabled
   * toggle (a router-level no-op), this actually stops/starts the flow's
   * bun subprocess; see main.ts's applyRunState. */
  onToggleDisabled: (next: boolean) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [mutationError, setMutationError] = useState<string | null>(null);
  const disabled = entry.wiring.disabled ?? false;

  return createPortal(
    <div
      className="create-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`${entry.wiring.name} details`}
    >
      <div className="create-dialog-panel">
        <h3>{entry.wiring.name}</h3>
        <div className="detail-rows">
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <FlowStatusBadge status={entry.status} />
          </div>
          <div className="detail-row">
            <span className="detail-label">File</span>
            <code>{entry.file}</code>
          </div>
          <div className="detail-row">
            <span className="detail-label">Nodes</span>
            <span>{Object.keys(entry.wiring.nodes).length}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Wires</span>
            <span>{entry.wiring.wires.length}</span>
          </div>
        </div>
        {entry.status.kind === "failed-typecheck" && (
          <pre className="flow-detail-typecheck-output">
            {entry.status.output}
          </pre>
        )}
        <label className="node-config-enabled-toggle">
          <input
            type="checkbox"
            checked={!disabled}
            onChange={async (e) => {
              const result = await onToggleDisabled(!e.target.checked);
              setMutationError(
                result.ok ? null : (result.error ?? "mutation failed"),
              );
            }}
          />
          {disabled ? "Disabled" : "Enabled"}
        </label>
        {mutationError && (
          <div className="node-config-error" role="alert">
            {mutationError}
          </div>
        )}
        <div className="create-dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
