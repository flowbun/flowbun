import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * Generic yes/no confirmation modal — portaled to document.body for the
 * same reason WirePortPickerModal is (see its own comment): escaping the
 * canvas's pan/zoom transform, which would otherwise hijack `position:
 * fixed` centering. onConfirm can fail (e.g. a server-side guard rejecting
 * the action) — the dialog stays open and shows the error rather than
 * closing optimistically, same pattern as CreateResourceDialog.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await onConfirm();
      if (result.ok) {
        onClose();
      } else {
        setError(result.error);
      }
    } finally {
      setConfirming(false);
    }
  }

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
        <div className="confirm-dialog-message">{message}</div>
        {error && <div className="create-dialog-error">{error}</div>}
        <div className="create-dialog-actions">
          <button type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="create-dialog-submit-danger"
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
