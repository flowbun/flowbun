import type { BlockPaletteEntry } from "flowbun/ws";

/**
 * Mobile monitor-mode counterpart to ConfigEditor — read-only, no Save
 * button. Editing on mobile is deferred to a later pass (see README), so
 * this deliberately doesn't share ConfigEditor's form/state, keeping the
 * desktop editing path untouched.
 */
export function NodeInfoSheet({
  nodeId,
  block,
  config,
  def,
  onClose,
}: {
  nodeId: string;
  block: string;
  config: unknown;
  def: BlockPaletteEntry | undefined;
  onClose: () => void;
}) {
  const configEntries = Object.entries(
    (config ?? def?.defaultConfig ?? {}) as Record<string, unknown>,
  );
  const inputs = def ? Object.keys(def.inputs) : [];
  const outputs = def ? Object.keys(def.outputs) : [];

  return (
    <div
      className="node-info-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`${nodeId} info`}
    >
      <div className="node-info-sheet">
        <div className="node-info-header">
          <strong>{nodeId}</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="node-info-block">{block}</div>

        <div className="node-info-section">
          <h4>Ports</h4>
          <div className="node-info-ports">
            <span>in: {inputs.join(", ") || "—"}</span>
            <span>out: {outputs.join(", ") || "—"}</span>
          </div>
        </div>

        <div className="node-info-section">
          <h4>Config (read-only)</h4>
          {configEntries.length === 0 ? (
            <div className="node-info-empty">No config fields.</div>
          ) : (
            <dl className="node-info-config">
              {configEntries.map(([key, value]) => (
                <div key={key} className="node-info-config-row">
                  <dt>{key}</dt>
                  <dd>
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
