import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  type Node,
  useEdges,
  useNodesData,
} from "@xyflow/react";
import { useRef, useState } from "react";
import { generateRequestId } from "../../lib/requestId";
import { activityKey, useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import type { BlockNodeData, WireEdgeData } from "./useFlowGraph";
import { useWireActivityDots } from "./useWireActivityDots";
import { WirePortPickerModal } from "./WirePortPickerModal";

const BASE_OFFSET_PCT = 5;
const OFFSET_STEP_PCT = 6;
const MAX_OFFSET_PCT = 42;

/**
 * All wires out of (or into) a node now leave from the exact same point
 * (see BlockNode's single shared handle), so a fixed label offset would
 * stack every sibling's label directly on top of each other right at that
 * point on any block with more than one or two wires on a side. Staggering
 * by this edge's rank among its same-side siblings — ordered by id, so
 * every edge agrees on everyone else's rank without needing to communicate —
 * spreads them out along the curve instead, still comfortably "near" that
 * end.
 */
function staggeredOffsetPct(rank: number): number {
  return Math.min(BASE_OFFSET_PCT + rank * OFFSET_STEP_PCT, MAX_OFFSET_PCT);
}

/**
 * A tap/click target for deleting a wire — mobile has no Backspace key to
 * trigger React Flow's built-in onEdgesDelete, so selecting an edge here
 * surfaces an explicit delete button instead (also usable on desktop).
 *
 * Also renders each wire's actual source/target port name as a label that
 * tracks the wire's own path via CSS motion-path (following its curve and
 * rotating with its tangent), near whichever end it names — every node now
 * exposes just one shared connection point per side (see BlockNode), so
 * this label is the only place a port's identity is visible at all. Clicking
 * a label opens a modal to reassign that end to a different port.
 *
 * Rendered through EdgeLabelRenderer (an HTML overlay painted after every
 * edge's own SVG, same as the delete button below) rather than as an inline
 * SVG <textPath> — with several wires converging on one shared point, their
 * invisible click hit-areas (`.react-flow__edge-interaction`) overlap right
 * where labels live, and whichever edge is later in the DOM would silently
 * steal clicks meant for an earlier edge's label if it stayed inside the
 * SVG edge layer. The HTML overlay sits above all of that.
 *
 * Also animates a small dot along the wire (see useWireActivityDots)
 * whenever the source node actually produces a value on this wire's source
 * port — a lightweight activity indicator, not a literal visualization of
 * message transit time (which happens near-instantly from the user's
 * perspective regardless of wire length).
 */
export function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  target,
  selected,
  data,
}: EdgeProps) {
  const { send, state } = useFlowbunSocket();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const { file, sourcePort, targetPort, flowName } =
    (data as WireEdgeData) ?? {};
  const [pickerSide, setPickerSide] = useState<"source" | "target" | null>(
    null,
  );

  const pathRef = useRef<SVGPathElement>(null);
  const activitySeq =
    flowName && sourcePort
      ? state.activity.get(activityKey(flowName, source, sourcePort))
      : undefined;
  const { dots, handleDotDone } = useWireActivityDots(activitySeq, pathRef);

  const allEdges = useEdges();
  const sourceRank = allEdges
    .filter((e) => e.source === source)
    .sort((a, b) => a.id.localeCompare(b.id))
    .findIndex((e) => e.id === id);
  const targetRank = allEdges
    .filter((e) => e.target === target)
    .sort((a, b) => a.id.localeCompare(b.id))
    .findIndex((e) => e.id === id);

  const sourceNodeData = useNodesData<Node<BlockNodeData>>(source);
  const targetNodeData = useNodesData<Node<BlockNodeData>>(target);
  const outputPorts = sourceNodeData?.data.def
    ? Object.keys(sourceNodeData.data.def.outputs)
    : [];
  const inputPorts = targetNodeData?.data.def
    ? Object.keys(targetNodeData.data.def.inputs)
    : [];

  function handleDelete() {
    if (!file || !sourcePort || !targetPort) return;
    send({
      type: "wiring.mutate",
      requestId: generateRequestId(),
      file,
      mutation: {
        op: "wire.remove",
        from: `${source}.${sourcePort}`,
        to: `${target}.${targetPort}`,
      },
    });
  }

  function handleRewire(side: "source" | "target", newPort: string) {
    if (!file || !sourcePort || !targetPort) return;
    send({
      type: "wiring.mutate",
      requestId: generateRequestId(),
      file,
      mutation: {
        op: "wire.rewire",
        from: `${source}.${sourcePort}`,
        to: `${target}.${targetPort}`,
        newFrom:
          side === "source"
            ? `${source}.${newPort}`
            : `${source}.${sourcePort}`,
        newTo:
          side === "target"
            ? `${target}.${newPort}`
            : `${target}.${targetPort}`,
      },
    });
  }

  function portLabel(
    side: "source" | "target",
    port: string,
    offsetPct: number,
  ) {
    const label = `Reassign ${side === "source" ? "output" : "input"} port (currently "${port}")`;
    return (
      <button
        type="button"
        className="edge-port-label-html nodrag nopan"
        style={{
          offsetPath: `path('${edgePath}')`,
          offsetDistance: `${offsetPct}%`,
          offsetRotate: "auto",
        }}
        aria-label={label}
        title={label}
        onClick={() => setPickerSide(side)}
      >
        {port}
      </button>
    );
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {/* Invisible, purely so useWireActivityDots can measure the wire's
          real on-screen curve length via the DOM's own getTotalLength() —
          BaseEdge doesn't expose a ref to its own internal path. */}
      <path
        ref={pathRef}
        d={edgePath}
        fill="none"
        stroke="none"
        style={{ pointerEvents: "none" }}
      />
      <EdgeLabelRenderer>
        {dots.map((dot) => (
          <div
            key={dot.id}
            className="wire-activity-dot"
            style={{
              offsetPath: `path('${edgePath}')`,
              animationDuration: `${dot.duration}s`,
            }}
            onAnimationEnd={() => handleDotDone(dot.id)}
          />
        ))}
        {sourcePort &&
          portLabel(
            "source",
            sourcePort,
            staggeredOffsetPct(Math.max(sourceRank, 0)),
          )}
        {targetPort &&
          portLabel(
            "target",
            targetPort,
            100 - staggeredOffsetPct(Math.max(targetRank, 0)),
          )}
        {selected && (
          <button
            type="button"
            className="edge-delete-button nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={handleDelete}
            aria-label="Delete wire"
          >
            ✕
          </button>
        )}
      </EdgeLabelRenderer>
      {pickerSide === "source" && sourcePort && (
        <WirePortPickerModal
          title={`Output from "${source}"`}
          ports={outputPorts}
          current={sourcePort}
          onSelect={(port) => handleRewire("source", port)}
          onClose={() => setPickerSide(null)}
        />
      )}
      {pickerSide === "target" && targetPort && (
        <WirePortPickerModal
          title={`Input into "${target}"`}
          ports={inputPorts}
          current={targetPort}
          onSelect={(port) => handleRewire("target", port)}
          onClose={() => setPickerSide(null)}
        />
      )}
    </>
  );
}
