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
import { useCallback, useEffect, useState } from "react";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { BlockNode } from "./BlockNode";
import { type BlockNodeData, useFlowGraph } from "./useFlowGraph";

const nodeTypes = { block: BlockNode };

let nextIdSuffix = 1;
function freshNodeId(blockName: string, wiring: Wiring): string {
  const base = blockName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "");
  let id = base;
  while (id in wiring.nodes || id === "") {
    id = `${base}_${nextIdSuffix++}`;
  }
  return id;
}

function Inner({
  file,
  wiring,
  palette,
  onOpenBlockEditor,
  onSelectNode,
  readOnly = false,
}: {
  file: string;
  wiring: Wiring;
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (blockFile: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  readOnly?: boolean;
}) {
  const { send } = useFlowbunSocket();
  const { nodes: graphNodes, edges: graphEdges } = useFlowGraph(
    wiring,
    palette,
  );
  const [nodes, setNodes] = useState<Node<BlockNodeData>[]>(graphNodes);
  const [edges, setEdges] = useState<Edge[]>(graphEdges);
  const rf = useReactFlow();

  // The server (via flow.updated broadcasts) is the sole source of truth —
  // no optimistic local mutation of graph state on user actions; this
  // effect is what actually updates the canvas after every server ack.
  useEffect(() => {
    setNodes(graphNodes);
    setEdges(graphEdges);
  }, [graphNodes, graphEdges]);

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
        requestId: crypto.randomUUID(),
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
        requestId: crypto.randomUUID(),
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
          requestId: crypto.randomUUID(),
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
          requestId: crypto.randomUUID(),
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
        requestId: crypto.randomUUID(),
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
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      deleteKeyCode={readOnly ? null : undefined}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={readOnly ? undefined : onNodeDragStop}
      onConnect={readOnly ? undefined : onConnect}
      onNodesDelete={readOnly ? undefined : onNodesDelete}
      onEdgesDelete={readOnly ? undefined : onEdgesDelete}
      onDrop={readOnly ? undefined : onDrop}
      onDragOver={readOnly ? undefined : onDragOver}
      onNodeDoubleClick={readOnly ? undefined : onNodeDoubleClick}
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
  readOnly?: boolean;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
