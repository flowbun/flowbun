import { createPortal } from "react-dom";

/**
 * Rendered via createPortal straight to document.body rather than through
 * React Flow's EdgeLabelRenderer — that portal target sits inside the
 * canvas's pan/zoom `transform`, which becomes the containing block for any
 * `position: fixed` descendant (per the CSS spec) and would trap this
 * modal's centering inside the transformed viewport instead of the real
 * browser window. Escaping to `document.body` sidesteps that entirely, same
 * as CreateResourceDialog's overlay does by being mounted at the app root.
 */
export function WirePortPickerModal({
  title,
  ports,
  current,
  onSelect,
  onClose,
}: {
  title: string;
  ports: string[];
  current: string;
  onSelect: (port: string) => void;
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="create-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="create-dialog-panel">
        <h3>{title}</h3>
        <div className="port-picker-list">
          {ports.map((port) => (
            <button
              key={port}
              type="button"
              className={`port-picker-option ${port === current ? "selected" : ""}`}
              onClick={() => {
                if (port !== current) onSelect(port);
                onClose();
              }}
            >
              {port}
            </button>
          ))}
        </div>
        <div className="create-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
