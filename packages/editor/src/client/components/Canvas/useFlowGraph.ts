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
  /** The wiring's own `name` field (not the filename) — same field, same
   * rationale as WireEdgeData.flowName below: BlockNode needs it to send a
   * flow.fireNode request for @core/inject nodes. */
  flowName: string;
  /** Wiring file this node belongs to — stitched in by FlowCanvas, not here
   * (useFlowGraph has no notion of "which file", only a Wiring value), same
   * as WireEdgeData.file below. BlockNode needs it to send a node.config
   * mutation for a `control: {kind: "toggle"}` block's on-canvas switch. */
  file?: string;
}

/** Every wire's edge.data — the actual port names, since handles no longer
 * disambiguate them (see BlockNode's single shared handle per side). */
export interface WireEdgeData extends Record<string, unknown> {
  sourcePort: string;
  targetPort: string;
  /** The wiring's own `name` field (not the filename) — matches the `flow`
   * field on every log entry, so DeletableEdge can key into
   * FlowbunSocketContext's activity map for its wire-activity dots. */
  flowName: string;
  /** Wiring file this edge belongs to — stitched in by FlowCanvas, not here
   * (useFlowGraph has no notion of "which file", only a Wiring value). */
  file?: string;
}

export function useFlowGraph(
  wiring: Wiring | undefined,
  palette: BlockPaletteEntry[],
): { nodes: Node<BlockNodeData>[]; edges: Edge<WireEdgeData>[] } {
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
          flowName: wiring.name,
        },
      }),
    );

    const edges: Edge<WireEdgeData>[] = wiring.wires.map(([from, to], i) => {
      const src = parsePortRef(from);
      const dst = parsePortRef(to);
      return {
        id: `${from}->${to}#${i}`,
        source: src.nodeId,
        target: dst.nodeId,
        // No sourceHandle/targetHandle: every node now has exactly one
        // handle per side (see BlockNode), so there's nothing to select —
        // the actual port this wire is bound to lives in `data` instead,
        // read by DeletableEdge for its curved labels and by FlowCanvas's
        // onEdgesDelete to reconstruct the wire.remove mutation.
        data: {
          sourcePort: src.port,
          targetPort: dst.port,
          flowName: wiring.name,
        },
      };
    });

    return { nodes, edges };
  }, [wiring, palette]);
}
