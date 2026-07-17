import type { BlockPaletteEntry, HassEntitySummary } from "flowbun/ws";
import { useEffect, useState } from "react";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

/** Fields named "entity" on these blocks get a datalist of live HA entity IDs. */
const HASS_ENTITY_FIELD_BLOCKS = new Set(["@hass/trigger"]);

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
  onRename,
}: {
  nodeId: string;
  block: string;
  config: unknown;
  def: BlockPaletteEntry | undefined;
  disabled: boolean;
  onToggleDisabled: (next: boolean) => Promise<{ ok: boolean; error?: string }>;
  onSave: (config: unknown) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  onDelete: () => Promise<{ ok: boolean; error?: string }>;
  onOpenBlockEditor: (blockFile: string) => void;
  onRename: (newNodeId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const defaultConfig = def?.defaultConfig;
  const base = (config ?? defaultConfig ?? {}) as Record<string, unknown>;
  const template = (defaultConfig ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, unknown>>(base);
  const [hassEntities, setHassEntities] = useState<HassEntitySummary[]>([]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const { send } = useFlowbunSocket();

  // useState(base)'s initializer only runs on mount -- without this, the
  // form silently kept showing whatever was true at that moment forever
  // after, even once `config`/`def` changed underneath it (e.g. a block's
  // own default config shape changing after a code edit + blocks reload,
  // or a wiring.mutate from another tab/agent). Deliberately overwrites
  // any in-progress unsaved edits when it fires -- this panel mirrors live
  // external state rather than owning a separate draft, same as every
  // other write in this app (HA de-dupes/reflects reality, not "what I
  // last typed"). Switching to a *different* node is handled separately,
  // by remounting this component entirely (see its `key` in App.tsx) --
  // this effect only needs to cover the same-node case.
  useEffect(() => {
    setValues((config ?? def?.defaultConfig ?? {}) as Record<string, unknown>);
  }, [config, def]);

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  // Every mutation prop below returns {ok, error?} rather than being
  // fire-and-forget — a failed wiring.mutate (e.g. the node.disabled toggle
  // this wraps) used to be silently discarded here, so a click that looked
  // like it worked in the UI could leave the actual running flow completely
  // unchanged with no indication anything went wrong. See ws-server.ts's
  // wiring.mutate handler, which always replies with ok/error either way.
  async function runMutation(
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ) {
    const result = await fn();
    setMutationError(result.ok ? null : (result.error ?? "mutation failed"));
    return result;
  }

  const wantsHassEntities = HASS_ENTITY_FIELD_BLOCKS.has(block);
  useEffect(() => {
    if (!wantsHassEntities) return;
    let cancelled = false;
    send({ type: "hass.entities", requestId: generateRequestId() }).then(
      (r) => {
        if (cancelled) return;
        if (r.type === "hass.entitiesResult" && r.ok)
          setHassEntities(r.entities);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantsHassEntities, send]);

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
          <input
            key={nodeId}
            type="text"
            className="node-config-id-input"
            defaultValue={nodeId}
            aria-label="Node name"
            title="Node name — also the display label used on the canvas and in wires"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (!next || next === nodeId) {
                e.target.value = nodeId; // revert: empty or unchanged
                return;
              }
              runMutation(() => onRename(next));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = nodeId;
                e.currentTarget.blur();
              }
            }}
          />
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
          onChange={(e) =>
            runMutation(() => onToggleDisabled(!e.target.checked))
          }
        />
        {disabled ? "Disabled" : "Enabled"}
      </label>

      {mutationError && (
        <div className="node-config-error" role="alert">
          {mutationError}
        </div>
      )}

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
                <>
                  <input
                    id={fieldId}
                    type="text"
                    value={typeof current === "string" ? current : ""}
                    onChange={(e) => setField(key, e.target.value)}
                    list={
                      wantsHassEntities && key === "entity"
                        ? `${fieldId}-entities`
                        : undefined
                    }
                    autoComplete="off"
                  />
                  {wantsHassEntities && key === "entity" && (
                    <datalist id={`${fieldId}-entities`}>
                      {hassEntities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.friendlyName
                            ? `${e.id} — ${e.friendlyName}`
                            : e.id}
                        </option>
                      ))}
                    </datalist>
                  )}
                </>
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
          onClick={() => runMutation(() => onSave(values))}
        >
          Save
        </button>
        <button
          type="button"
          className="node-config-delete"
          onClick={() => runMutation(onDelete)}
        >
          Delete node
        </button>
      </div>
    </div>
  );
}
