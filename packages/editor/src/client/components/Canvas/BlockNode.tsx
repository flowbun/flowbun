import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { BlockNodeData } from "./useFlowGraph";

const isHassBlock = (block: string) => block.startsWith("@hass/");

export function BlockNode({ data }: NodeProps & { data: BlockNodeData }) {
  const inputs = data.def ? Object.keys(data.def.inputs) : [];
  const outputs = data.def ? Object.keys(data.def.outputs) : [];

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

      {inputs.map((port, i) => (
        <Handle
          key={`in-${port}`}
          type="target"
          position={Position.Left}
          id={port}
          style={{ top: 32 + i * 16, background: "var(--text-dim)" }}
          title={port}
        />
      ))}
      {outputs.map((port, i) => (
        <Handle
          key={`out-${port}`}
          type="source"
          position={Position.Right}
          id={port}
          style={{ top: 32 + i * 16, background: "var(--accent)" }}
          title={port}
        />
      ))}
    </div>
  );
}
