import { useState } from "react";

// Cosmetic-only preview of what the server will slugify the name into —
// the server (main.ts's slugifyName) remains the sole authority on the
// actual slug, validation, and collision checking.
function slugPreview(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Shared shape behind "New flow" and "New block": prompt for a name, show
 * a live filename preview, submit, surface a server-side error (most
 * commonly a name collision) without closing so the user can just retype.
 */
export function CreateResourceDialog({
  title,
  label,
  placeholder,
  previewSuffix,
  ariaLabel,
  onClose,
  onCreate,
}: {
  title: string;
  label: string;
  placeholder: string;
  /** e.g. ".json" or ".ts" — appended to the slug preview only. */
  previewSuffix: string;
  ariaLabel: string;
  onClose: () => void;
  onCreate: (
    name: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await onCreate(name);
      if (result.ok) {
        onClose();
      } else {
        setError(result.error);
      }
    } finally {
      setCreating(false);
    }
  }

  const preview = slugPreview(name);

  return (
    <div
      className="create-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="create-dialog-panel">
        <h3>{title}</h3>
        <label htmlFor="create-dialog-name">{label}</label>
        <input
          id="create-dialog-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          placeholder={placeholder}
        />
        {preview && (
          <div className="create-dialog-preview">
            saved as{" "}
            <code>
              {preview}
              {previewSuffix}
            </code>
          </div>
        )}
        {error && <div className="create-dialog-error">{error}</div>}
        <div className="create-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="create-dialog-submit"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
