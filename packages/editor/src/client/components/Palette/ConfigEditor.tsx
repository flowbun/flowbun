import type { BlockPaletteEntry } from "flowbun/ws";
import { useState } from "react";

/**
 * One form control per key of the block's defaultConfig, picked by
 * `typeof` the default value — deliberately simple and functional, not a
 * design showcase (per the plan: config editing is the least important
 * piece of the write-back story). Responsive: a floating panel on desktop,
 * a full-width bottom sheet on mobile (see styles.css).
 */
export function ConfigEditor({
  nodeId,
  block,
  config,
  def,
  disabled,
  onToggleDisabled,
  onSave,
  onClose,
  onDelete,
  onOpenBlockEditor,
}: {
  nodeId: string;
  block: string;
  config: unknown;
  def: BlockPaletteEntry | undefined;
  disabled: boolean;
  onToggleDisabled: (next: boolean) => void;
  onSave: (config: unknown) => void;
  onClose: () => void;
  onDelete: () => void;
  onOpenBlockEditor: (blockFile: string) => void;
}) {
  const defaultConfig = def?.defaultConfig;
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

  const inputs = def ? Object.keys(def.inputs) : [];
  const outputs = def ? Object.keys(def.outputs) : [];
  const sourceFile = def?.file;

  return (
    <div className="node-config-panel">
      <div className="node-config-header">
        <div>
          <strong>{nodeId}</strong>
          <div className="node-config-block">{block}</div>
        </div>
        <div className="node-config-header-actions">
          {sourceFile && (
            <button
              type="button"
              onClick={() => onOpenBlockEditor(sourceFile)}
              title="Edit source"
              aria-label="Edit source"
            >
              ✎
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <label className="node-config-enabled-toggle">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(e) => onToggleDisabled(!e.target.checked)}
        />
        {disabled ? "Disabled" : "Enabled"}
      </label>

      <div className="node-config-section">
        <h4>Ports</h4>
        <div className="node-config-ports">
          <span>in: {inputs.join(", ") || "—"}</span>
          <span>out: {outputs.join(", ") || "—"}</span>
        </div>
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

      <div className="node-config-actions">
        <button
          type="button"
          className="node-config-save"
          onClick={() => onSave(values)}
        >
          Save
        </button>
        <button type="button" className="node-config-delete" onClick={onDelete}>
          Delete node
        </button>
      </div>
    </div>
  );
}
