import type { BlockPaletteEntry, HassEntitySummary } from "flowbun/ws";
import { useEffect, useState } from "react";
import { configFieldKeys } from "../../lib/configFieldKeys";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

/** Fields named "entity" on these blocks get a datalist of live HA entity IDs. */
const HASS_ENTITY_FIELD_BLOCKS = new Set(["@hass/trigger"]);

/**
 * One form control per config key, picked by `typeof` the default value (or,
 * for keys the default doesn't carry, the node's own value) — deliberately
 * simple and functional, not a design showcase (per the plan: config editing
 * is the least important piece of the write-back story). Responsive: a
 * floating panel on desktop, a full-width bottom sheet on mobile (see
 * styles.css).
 *
 * A `typeof`-driven form can only ever offer keys something already
 * mentions, which leaves the other arms of a discriminated-union config
 * (`@core/scheduler`'s `mode: "sunRelative"` wants `event`/`latitude`/
 * `longitude`, named by neither the default nor a `dailyTime` node) with no
 * way in at all. Hence the raw-JSON `<details>` at the bottom: the same
 * `values` state, edited wholesale, so anything the generated form
 * structurally cannot express is still reachable without hand-editing the
 * wiring file.
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
  onFork,
  sharedWith,
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
  /** Invoked by ✎ when this node's block is a built-in, which has no `file`
   * to open: built-ins live in the image under packages/runtime and are
   * replaced on every rebuild, so there is nothing editable to point Monaco
   * at. Forking copies it into data/blocks/ and repoints this node alone —
   * see App.tsx's handleForkBlockForNode. */
  onFork: () => void;
  /** How many OTHER nodes, across every flow, use this same block — the ✎ on
   * an add-on block edits one shared source file, so a node that isn't the
   * only user needs to say so before the user finds out by breaking three
   * automations at once. */
  sharedWith: number;
  onRename: (newNodeId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const defaultConfig = def?.defaultConfig;
  const base = (config ?? defaultConfig ?? {}) as Record<string, unknown>;
  const template = (defaultConfig ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, unknown>>(base);
  const [hassEntities, setHassEntities] = useState<HassEntitySummary[]>([]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // The raw-JSON escape hatch deliberately does NOT own a second copy of the
  // config: `values` stays the single source of truth, and a keystroke there
  // that parses is applied to `values` immediately. `jsonDraft` is only the
  // literal text in the textarea while it's being typed in (null = "nothing
  // in flight, render `values`"), so the user's own whitespace/key order
  // survives mid-edit instead of being re-serialised under the cursor.
  // `jsonError` is what makes the round trip honest — see the save handler.
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
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
    // Same reasoning one level down: an in-flight JSON draft is exactly the
    // kind of "separate draft" this effect exists to refuse to keep alive.
    setJsonDraft(null);
    setJsonError(null);
  }, [config, def]);

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
    // Editing the generated form makes any pending JSON text stale (and any
    // parse error it was holding moot), so drop it and let the JSON view
    // re-derive from `values`. Form and JSON view are two renderings of one
    // state, never two states to reconcile.
    setJsonDraft(null);
    setJsonError(null);
  }

  /**
   * Unlike the per-field textarea below — which can afford to ignore
   * unparseable input, since the rest of the config still saves correctly
   * without it — a whole-config edit that silently fails to parse would make
   * Save appear to work while writing back the pre-edit config. So a bad
   * draft is surfaced and blocks the save outright rather than being
   * discarded.
   */
  function editJson(text: string) {
    setJsonDraft(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "invalid JSON");
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      setJsonError("config must be a JSON object");
      return;
    }
    setJsonError(null);
    setValues(parsed as Record<string, unknown>);
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

  // Union rather than "template if non-empty, else base" — see
  // configFieldKeys' own doc comment for the @core/scheduler case that made
  // fields disappear entirely. Unioned against live `values`, not the
  // node's saved config, so a key introduced via the raw-JSON editor gets a
  // real form control the moment it parses instead of after a save/reload.
  const keys = configFieldKeys(template, values);

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
          <button
            type="button"
            onClick={() =>
              sourceFile ? onOpenBlockEditor(sourceFile) : onFork()
            }
            title={
              sourceFile
                ? sharedWith > 0
                  ? `Edit ${block}'s source — shared with ${sharedWith} other ${sharedWith === 1 ? "node" : "nodes"}, which this will also change`
                  : `Edit ${block}'s source`
                : `Fork ${block} into an editable copy used only by this node`
            }
            aria-label={sourceFile ? "Edit source" : "Fork block for this node"}
          >
            ✎
          </button>
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
          // Keys the block's default config doesn't advertise (another
          // union arm's fields, or an optional key) get a quiet marker:
          // they're fully editable, but their type is inferred from the
          // node's current value alone, so there's no declared shape
          // vouching for them.
          const undeclared = !Object.hasOwn(template, key);
          return (
            <label key={key} htmlFor={fieldId}>
              {key}
              {undeclared && (
                <span
                  className="config-field-undeclared"
                  title="Not in this block's default config"
                >
                  •
                </span>
              )}
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
                  // Uncontrolled (defaultValue) so half-typed JSON isn't
                  // clobbered on every keystroke — but that also means it
                  // would happily keep showing pre-edit text after the raw
                  // JSON editor below rewrites this key underneath it.
                  // Keying on the serialised value remounts it exactly when
                  // the value actually changed from elsewhere, and never
                  // while it's the thing being typed into (this only
                  // commits on blur).
                  key={JSON.stringify(current ?? templateValue ?? null)}
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

      <details className="node-config-json">
        <summary>Raw JSON</summary>
        <textarea
          rows={8}
          spellCheck={false}
          aria-label="Raw config JSON"
          value={jsonDraft ?? JSON.stringify(values, null, 2)}
          onChange={(e) => editJson(e.target.value)}
        />
        {jsonError && (
          <div className="node-config-error" role="alert">
            {jsonError}
          </div>
        )}
      </details>

      <div className="node-config-actions">
        <button
          type="button"
          className="node-config-save"
          disabled={jsonError !== null}
          title={
            jsonError
              ? "Fix the raw JSON before saving"
              : "Save this node's config"
          }
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
