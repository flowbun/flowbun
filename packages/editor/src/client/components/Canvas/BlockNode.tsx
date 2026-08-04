import { Handle, type NodeProps, Position } from "@xyflow/react";
import { formatClockTime } from "../../lib/formatTime";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { useLastProcessed } from "./LastProcessedContext";
import type { BlockNodeData } from "./useFlowGraph";

const isHassBlock = (block: string) => block.startsWith("@hass/");

export function BlockNode({ data }: NodeProps & { data: BlockNodeData }) {
  const inputs = data.def ? Object.keys(data.def.inputs) : [];
  const outputs = data.def ? Object.keys(data.def.outputs) : [];
  const lastProcessedAt = useLastProcessed(data.nodeId);
  const { send } = useFlowbunSocket();
  // Declarative on-canvas control (see block.ts's BlockControl) — replaces
  // what used to be a hardcoded `data.block === "@core/inject"` check, so
  // any future control (this toggle included) only ever needs a case here,
  // never a new per-block-name branch.
  const control = data.def?.control;
  const isFire = control?.kind === "fire";
  // @core/inject's own config carries a user-customizable button label —
  // specific to the "fire" control, not part of BlockControl's generic
  // shape (every inject *node* can have its own label; a control is
  // per-block-type, not per-node).
  const injectLabel =
    (isFire && (data.config as { label?: string } | undefined)?.label) ||
    "Fire";

  async function handleFire(): Promise<void> {
    const result = await send({
      type: "flow.fireNode",
      requestId: generateRequestId(),
      flow: data.flowName,
      nodeId: data.nodeId,
    });
    if (result.type === "flow.fireNodeResult" && !result.ok) {
      console.error("inject fire failed:", result.error);
    }
  }

  async function handleToggleSelect(value: unknown): Promise<void> {
    if (control?.kind !== "toggle" || !data.file) return;
    const currentConfig = (data.config as Record<string, unknown> | null) ?? {};
    if (currentConfig[control.configKey] === value) return; // already selected
    const result = await send({
      type: "wiring.mutate",
      requestId: generateRequestId(),
      file: data.file,
      mutation: {
        op: "node.config",
        nodeId: data.nodeId,
        config: { ...currentConfig, [control.configKey]: value },
      },
    });
    if (result.type === "wiring.mutateResult" && !result.ok) {
      console.error("toggle failed:", result.error);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: `1px ${data.disabled ? "dashed" : "solid"} var(--border)`,
        borderRadius: 6,
        minWidth: 140,
        color: "var(--text)",
        fontSize: 12,
        opacity: data.disabled ? 0.5 : 1,
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          borderBottom:
            inputs.length || outputs.length
              ? "1px solid var(--border)"
              : "none",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {data.nodeId}
        {data.disabled && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-dim)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              padding: "1px 4px",
            }}
          >
            disabled
          </span>
        )}
      </div>
      <div
        style={{
          padding: "4px 10px 8px",
          color: isHassBlock(data.block) ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {data.block}
      </div>
      {isFire && (
        <div style={{ padding: "0 10px 8px" }}>
          <button
            type="button"
            className="nodrag nopan"
            disabled={data.disabled}
            title={injectLabel}
            onClick={handleFire}
            style={{
              width: "100%",
              padding: "3px 8px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: data.disabled ? "not-allowed" : "pointer",
            }}
          >
            ▶ {injectLabel}
          </button>
        </div>
      )}
      {control?.kind === "toggle" && (
        <div style={{ padding: "0 10px 8px" }}>
          <div
            className="nodrag nopan"
            style={{
              display: "flex",
              border: "1px solid var(--border)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            {control.values.map((value, i) => {
              const label = control.labels?.[i] ?? String(value);
              const active =
                (data.config as Record<string, unknown> | null)?.[
                  control.configKey
                ] === value;
              return (
                <button
                  key={label}
                  type="button"
                  disabled={data.disabled || active}
                  title={label}
                  onClick={() => handleToggleSelect(value)}
                  style={{
                    flex: 1,
                    padding: "3px 6px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: active ? "var(--bg)" : "var(--text-dim)",
                    background: active ? "var(--accent)" : "var(--bg)",
                    border: "none",
                    borderLeft: i > 0 ? "1px solid var(--border)" : "none",
                    cursor: data.disabled || active ? "not-allowed" : "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {lastProcessedAt !== undefined && (
        <div
          title={`last processed at ${formatClockTime(lastProcessedAt)}`}
          style={{
            padding: "0 10px 6px",
            fontSize: 9,
            color: "var(--text-dim)",
          }}
        >
          ⏱ {formatClockTime(lastProcessedAt)}
        </div>
      )}

      {/* One shared connection point per side, not one per port — every
          wire into/out of this node starts from the same spot regardless of
          which port it's actually assigned to. Which port a given wire
          means is disambiguated by its own curved label (see DeletableEdge),
          not by which handle it's plugged into. */}
      {inputs.length > 0 && (
        <Handle
          type="target"
          position={Position.Left}
          id={undefined}
          style={{ background: "var(--text-dim)" }}
          title={inputs.join(", ")}
        />
      )}
      {outputs.length > 0 && (
        <Handle
          type="source"
          position={Position.Right}
          id={undefined}
          style={{ background: "var(--accent)" }}
          title={outputs.join(", ")}
        />
      )}
    </div>
  );
}
