import type { Edge, Node } from "@xyflow/react";
// From the "flowbun/wiring" subpath, not the main "flowbun" barrel — that
// barrel pulls in bun:sqlite/@digital-alchemy/hass, which can't bundle for
// a browser target at all. See wiring/schema.ts's own comment.
import { parsePortRef, type Wiring } from "flowbun/wiring";
import type { BlockPaletteEntry } from "flowbun/ws";
import { useMemo } from "react";
import { autoLayout } from "../../layout/auto-layout";

export interface BlockNodeData extends Record<string, unknown> {
  nodeId: string;
  block: string;
  config: unknown;
  def: BlockPaletteEntry | undefined;
  disabled: boolean;
}

export function useFlowGraph(
  wiring: Wiring | undefined,
  palette: BlockPaletteEntry[],
): { nodes: Node<BlockNodeData>[]; edges: Edge[] } {
  return useMemo(() => {
    if (!wiring) return { nodes: [], edges: [] };
    const auto = autoLayout(wiring);
    const byName = new Map(palette.map((p) => [p.name, p]));

    const nodes: Node<BlockNodeData>[] = Object.entries(wiring.nodes).map(
      ([id, n]) => ({
        id,
        type: "block",
        position: n.position ?? auto[id] ?? { x: 0, y: 0 },
        data: {
          nodeId: id,
          block: n.block,
          config: n.config,
          def: byName.get(n.block),
          disabled: n.disabled ?? false,
        },
      }),
    );

    const edges: Edge[] = wiring.wires.map(([from, to], i) => {
      const src = parsePortRef(from);
      const dst = parsePortRef(to);
      return {
        id: `${from}->${to}#${i}`,
        source: src.nodeId,
        sourceHandle: src.port,
        target: dst.nodeId,
        targetHandle: dst.port,
      };
    });

    return { nodes, edges };
  }, [wiring, palette]);
}
