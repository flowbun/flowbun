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
  type Viewport,
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

function viewportKey(flowName: string): string {
  return `flowbun.viewport.${flowName}`;
}

function readStoredViewport(flowName: string): Viewport | undefined {
  try {
    const stored = window.localStorage.getItem(viewportKey(flowName));
    if (!stored) return undefined;
    const parsed = JSON.parse(stored);
    if (
      typeof parsed?.x === "number" &&
      typeof parsed?.y === "number" &&
      typeof parsed?.zoom === "number"
    ) {
      return parsed as Viewport;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeStoredViewport(flowName: string, viewport: Viewport): void {
  try {
    window.localStorage.setItem(
      viewportKey(flowName),
      JSON.stringify(viewport),
    );
  } catch {
    // localStorage unavailable/full (private browsing, quota) — viewport
    // just won't persist this session.
  }
}

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
  // FlowCanvas/Inner is never remounted when switching between flow tabs
  // (no `key` on it in App.tsx) — the same ReactFlowProvider persists for
  // the whole session, which is what lets a flow's viewport survive a tab
  // switch at all. This ref is how the effect below tells "switched to a
  // different flow" apart from "same flow, nodes/edges just changed".
  const currentFileRef = useRef(file);
  // Read once, lazily, for the very first flow shown this page load — fed
  // to <ReactFlow>'s defaultViewport/fitView props below so the correct
  // view applies on React Flow's own first paint instead of flashing an
  // untransformed viewport and then correcting it a tick later.
  const [initialViewport] = useState(() => readStoredViewport(wiring.name));

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

    if (currentFileRef.current !== file) {
      // Switched to a different flow tab — restore *that* flow's own last
      // viewport instead of comparing node counts against the flow we just
      // left (the bug this replaces: an unrelated flow with more nodes
      // than the previous one used to spuriously trigger a fitView here).
      currentFileRef.current = file;
      const stored = readStoredViewport(wiring.name);
      if (stored) rf.setViewport(stored, { duration: 0 });
      else rf.fitView({ duration: 0 });
    } else if (graphNodes.length > prevNodeCount.current) {
      // A node was added (desktop drag-drop or mobile tap-to-add) — its
      // placeholder position may well be outside the current pan/zoom,
      // with no way to find it otherwise. Re-fit only on a genuine count
      // increase, not on every drag/config-edit broadcast.
      rf.fitView({ duration: 300 });
    }
    prevNodeCount.current = graphNodes.length;
  }, [graphNodes, graphEdges, file, wiring.name, rf]);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      writeStoredViewport(wiring.name, viewport);
    },
    [wiring.name],
  );

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
        onMoveEnd={onMoveEnd}
        colorMode="dark"
        // Only auto-fit on this flow's very first-ever open in this
        // browser (no stored viewport yet) — once a viewport's been
        // persisted, defaultViewport takes over instead (fitView ignores
        // defaultViewport when both are set).
        fitView={!initialViewport}
        defaultViewport={initialViewport}
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
