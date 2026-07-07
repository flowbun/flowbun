import { useState } from "react";

/**
 * One form control per key of the block's defaultConfig, picked by
 * `typeof` the default value — deliberately simple and functional, not a
 * design showcase (per the plan: config editing is the least important
 * piece of the write-back story).
 */
export function ConfigEditor({
  nodeId,
  config,
  defaultConfig,
  onSave,
  onClose,
}: {
  nodeId: string;
  config: unknown;
  defaultConfig: unknown;
  onSave: (config: unknown) => void;
  onClose: () => void;
}) {
  const base = (config ?? defaultConfig ?? {}) as Record<string, unknown>;
  const template = (defaultConfig ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, unknown>>(base);

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  const keys =
    Object.keys(template).length > 0
      ? Object.keys(template)
      : Object.keys(base);

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        width: 260,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <strong>{nodeId} config</strong>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
      <div className="config-form">
        {keys.length === 0 && (
          <div style={{ color: "var(--text-dim)" }}>No config fields.</div>
        )}
        {keys.map((key) => {
          const current = values[key];
          const templateValue = template[key];
          const kind = typeof (templateValue ?? current);
          const fieldId = `config-field-${nodeId}-${key}`;
          return (
            <label key={key} htmlFor={fieldId}>
              {key}
              {kind === "boolean" ? (
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={Boolean(current)}
                  onChange={(e) => setField(key, e.target.checked)}
                />
              ) : kind === "number" ? (
                <input
                  id={fieldId}
                  type="number"
                  value={typeof current === "number" ? current : ""}
                  onChange={(e) => setField(key, Number(e.target.value))}
                />
              ) : kind === "string" ? (
                <input
                  id={fieldId}
                  type="text"
                  value={typeof current === "string" ? current : ""}
                  onChange={(e) => setField(key, e.target.value)}
                />
              ) : (
                <textarea
                  id={fieldId}
                  rows={3}
                  defaultValue={JSON.stringify(
                    current ?? templateValue ?? null,
                    null,
                    2,
                  )}
                  onBlur={(e) => {
                    try {
                      setField(key, JSON.parse(e.target.value));
                    } catch {
                      // leave as-is; invalid JSON just won't be applied on save
                    }
                  }}
                />
              )}
            </label>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onSave(values)}
        style={{
          background: "var(--accent-dim)",
          color: "var(--text)",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          padding: "6px 12px",
          cursor: "pointer",
          width: "100%",
        }}
      >
        Save
      </button>
    </div>
  );
}
