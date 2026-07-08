import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { Wiring } from "flowbun/wiring";
import type { BlockPaletteEntry } from "flowbun/ws";
import { useCallback, useEffect, useRef, useState } from "react";
import { freshNodeId } from "../../lib/freshNodeId";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { BlockNode } from "./BlockNode";
import { DeletableEdge } from "./DeletableEdge";
import { type BlockNodeData, useFlowGraph } from "./useFlowGraph";

const nodeTypes = { block: BlockNode };
const edgeTypes = { deletable: DeletableEdge };

function Inner({
  file,
  wiring,
  palette,
  onOpenBlockEditor,
  onSelectNode,
  isMobile = false,
}: {
  file: string;
  wiring: Wiring;
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (blockFile: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  isMobile?: boolean;
}) {
  const { send } = useFlowbunSocket();
  const { nodes: graphNodes, edges: graphEdges } = useFlowGraph(
    wiring,
    palette,
  );
  const [nodes, setNodes] = useState<Node<BlockNodeData>[]>(graphNodes);
  const [edges, setEdges] = useState<Edge[]>(graphEdges);
  const rf = useReactFlow();
  const prevNodeCount = useRef(graphNodes.length);

  // The server (via flow.updated broadcasts) is the sole source of truth —
  // no optimistic local mutation of graph state on user actions; this
  // effect is what actually updates the canvas after every server ack.
  // Edges are tagged "deletable" (a tap/click target for the X button — see
  // DeletableEdge) since mobile has no Backspace key to trigger onEdgesDelete.
  useEffect(() => {
    setNodes(graphNodes);
    setEdges(
      graphEdges.map((e) => ({ ...e, type: "deletable", data: { file } })),
    );
    // A node was added (desktop drag-drop or mobile tap-to-add) — its
    // placeholder position may well be outside the current pan/zoom, with
    // no way to find it otherwise. Re-fit only on a genuine count increase,
    // not on every drag/config-edit broadcast.
    if (graphNodes.length > prevNodeCount.current) {
      rf.fitView({ duration: 300 });
    }
    prevNodeCount.current = graphNodes.length;
  }, [graphNodes, graphEdges, file, rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<BlockNodeData>>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node<BlockNodeData>) => {
      send({
        type: "wiring.mutate",
        requestId: generateRequestId(),
        file,
        mutation: {
          op: "node.position",
          nodeId: node.id,
          position: { x: node.position.x, y: node.position.y },
        },
      });
    },
    [send, file],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return;
      send({
        type: "wiring.mutate",
        requestId: generateRequestId(),
        file,
        mutation: {
          op: "wire.add",
          from: `${connection.source}.${connection.sourceHandle}`,
          to: `${connection.target}.${connection.targetHandle}`,
        },
      });
    },
    [send, file],
  );

  const onNodesDelete = useCallback(
    (deleted: Node<BlockNodeData>[]) => {
      // Server cascades wire removal for a deleted node — no need to
      // separately remove that node's edges here.
      for (const n of deleted) {
        send({
          type: "wiring.mutate",
          requestId: generateRequestId(),
          file,
          mutation: { op: "node.remove", nodeId: n.id },
        });
      }
    },
    [send, file],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        if (!e.sourceHandle || !e.targetHandle) continue;
        send({
          type: "wiring.mutate",
          requestId: generateRequestId(),
          file,
          mutation: {
            op: "wire.remove",
            from: `${e.source}.${e.sourceHandle}`,
            to: `${e.target}.${e.targetHandle}`,
          },
        });
      }
    },
    [send, file],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const blockName = event.dataTransfer.getData("application/flowbun-block");
      if (!blockName) return;
      const position = rf.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const nodeId = freshNodeId(blockName, wiring);
      send({
        type: "wiring.mutate",
        requestId: generateRequestId(),
        file,
        mutation: { op: "node.add", nodeId, block: blockName, position },
      });
    },
    [send, file, wiring, rf],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Double-click-to-edit-source is a desktop-only shortcut: on touch, a
  // double-tap on a node is ambiguous with double-tap-to-zoom, and mobile
  // has an explicit "edit source" button in the config panel instead.
  const onNodeDoubleClick = useCallback(
    (_event: unknown, node: Node<BlockNodeData>) => {
      const blockFile = node.data.def?.file;
      if (blockFile) onOpenBlockEditor(blockFile);
    },
    [onOpenBlockEditor],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onNodeDoubleClick={isMobile ? undefined : onNodeDoubleClick}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      colorMode="dark"
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

export function FlowCanvas(props: {
  file: string;
  wiring: Wiring;
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (blockFile: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  isMobile?: boolean;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
