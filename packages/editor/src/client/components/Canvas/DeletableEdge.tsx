import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

/**
 * A tap/click target for deleting a wire — mobile has no Backspace key to
 * trigger React Flow's built-in onEdgesDelete, so selecting an edge here
 * surfaces an explicit delete button instead (also usable on desktop).
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
  sourceHandleId,
  targetHandleId,
  selected,
  data,
}: EdgeProps) {
  const { send } = useFlowbunSocket();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const file = (data as { file?: string } | undefined)?.file;

  function handleDelete() {
    if (!file || !sourceHandleId || !targetHandleId) return;
    send({
      type: "wiring.mutate",
      requestId: generateRequestId(),
      file,
      mutation: {
        op: "wire.remove",
        from: `${source}.${sourceHandleId}`,
        to: `${target}.${targetHandleId}`,
      },
    });
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {selected && (
        <EdgeLabelRenderer>
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
        </EdgeLabelRenderer>
      )}
    </>
  );
}
