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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { freshNodeId } from "../../lib/freshNodeId";
import { pickDefaultPort, usedPortsForNode } from "../../lib/pickWirePort";
import { generateRequestId } from "../../lib/requestId";
import {
  lastProcessedKey,
  useFlowbunSocket,
} from "../../ws/FlowbunSocketContext";
import { BlockNode } from "./BlockNode";
import { DeletableEdge } from "./DeletableEdge";
import { LastProcessedProvider } from "./LastProcessedContext";
import {
  type BlockNodeData,
  useFlowGraph,
  type WireEdgeData,
} from "./useFlowGraph";

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
  const {
    send,
    state: { lastProcessed },
  } = useFlowbunSocket();
  const { nodes: graphNodes, edges: graphEdges } = useFlowGraph(
    wiring,
    palette,
  );
  // Rescoped to plain nodeId keys — the active canvas only ever shows one
  // flow's nodes, and BlockNode shouldn't need to know the flow name.
  const flowLastProcessed = useMemo(() => {
    const prefix = `${lastProcessedKey(wiring.name, "")}`;
    const scoped = new Map<string, number>();
    for (const [key, at] of lastProcessed) {
      if (key.startsWith(prefix)) scoped.set(key.slice(prefix.length), at);
    }
    return scoped;
  }, [lastProcessed, wiring.name]);
  const [nodes, setNodes] = useState<Node<BlockNodeData>[]>(graphNodes);
  const [edges, setEdges] = useState<Edge<WireEdgeData>[]>(graphEdges);
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
      // useFlowGraph always populates sourcePort/targetPort on every edge —
      // only `file` needs stitching in here, since useFlowGraph has no
      // notion of "which wiring file" (see WireEdgeData's own comment).
      graphEdges.map((e) => ({
        ...e,
        type: "deletable",
        data: { ...(e.data as WireEdgeData), file },
      })),
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
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge<WireEdgeData>>[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [],
  );

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

  // Every node exposes exactly one connection point per side now (see
  // BlockNode), so a drawn wire can't tell us which port it meant — guess
  // the first port on each end that isn't already used by another wire
  // (falling back to each block's first port if all are taken). Wrong
  // guesses are corrected via the wire's own curved label, not by rejecting
  // the connection outright.
  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      const outputs = sourceNode?.data.def
        ? Object.keys(sourceNode.data.def.outputs)
        : [];
      const inputs = targetNode?.data.def
        ? Object.keys(targetNode.data.def.inputs)
        : [];
      const sourcePort = pickDefaultPort(
        outputs,
        usedPortsForNode(wiring, connection.source, "source"),
      );
      const targetPort = pickDefaultPort(
        inputs,
        usedPortsForNode(wiring, connection.target, "target"),
      );
      if (!sourcePort || !targetPort) return;
      send({
        type: "wiring.mutate",
        requestId: generateRequestId(),
        file,
        mutation: {
          op: "wire.add",
          from: `${connection.source}.${sourcePort}`,
          to: `${connection.target}.${targetPort}`,
        },
      });
    },
    [send, file, nodes, wiring],
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
    (deleted: Edge<WireEdgeData>[]) => {
      for (const e of deleted) {
        if (!e.data?.sourcePort || !e.data?.targetPort) continue;
        send({
          type: "wiring.mutate",
          requestId: generateRequestId(),
          file,
          mutation: {
            op: "wire.remove",
            from: `${e.source}.${e.data.sourcePort}`,
            to: `${e.target}.${e.data.targetPort}`,
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
    <LastProcessedProvider value={flowLastProcessed}>
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
        // Default is "Space" — a window-level keydown listener that's live
        // whenever this canvas is mounted, including underneath overlays
        // like MonacoBlockEditor. If focus isn't exactly on an input when
        // Space is pressed, ReactFlow swallows it as pan-activation instead
        // of letting it reach the overlay. Nothing here relies on
        // hold-space-to-pan (drag panning works without it), so disabling
        // it removes the whole class of bug rather than just this instance.
        panActivationKeyCode={null}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </LastProcessedProvider>
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
