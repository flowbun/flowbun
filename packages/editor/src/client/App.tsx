import { useEffect, useState } from "react";
import { MonacoBlockEditor } from "./components/BlockEditor/MonacoBlockEditor";
import { FlowCanvas } from "./components/Canvas/FlowCanvas";
import { LogPanel } from "./components/LogPanel/LogPanel";
import { ConfigEditor } from "./components/Palette/ConfigEditor";
import { PaletteSidebar } from "./components/Palette/PaletteSidebar";
import { FlowStatusBadge } from "./components/StatusBar/FlowStatusBadge";
import { useIsMobile } from "./hooks/useIsMobile";
import { freshNodeId } from "./lib/freshNodeId";
import { generateRequestId } from "./lib/requestId";
import { navigate, useRoute } from "./lib/route";
import {
  FlowbunSocketProvider,
  useFlowbunSocket,
} from "./ws/FlowbunSocketContext";

function Shell() {
  const { state, send } = useFlowbunSocket();
  const isMobile = useIsMobile();
  const route = useRoute();
  const files = [...state.flows.keys()];
  const [blockEditorFile, setBlockEditorFile] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const activeFile = route.file ?? files[0] ?? null;
  const selectedNodeId = route.file ? route.nodeId : null;
  const entry = activeFile ? state.flows.get(activeFile) : undefined;
  const selectedNode =
    selectedNodeId && entry ? entry.wiring.nodes[selectedNodeId] : undefined;
  const selectedDef = selectedNode
    ? state.palette.find((p) => p.name === selectedNode.block)
    : undefined;

  // No flow in the URL yet (fresh "/" load), or the URL names a flow file
  // that doesn't exist (stale link, renamed file) — once the snapshot tells
  // us what flows actually exist, silently fall back to the first one.
  // replace, not push: this is filling in a default, not a navigation the
  // user asked for, so it shouldn't add a spurious back-button entry.
  useEffect(() => {
    if (files.length === 0) return;
    if (!route.file || !state.flows.has(route.file)) {
      navigate(files[0] as string, null, { replace: true });
    }
  }, [route.file, state.flows, files.length, files[0]]);

  // Native HTML5 drag-and-drop (the desktop add-block path) doesn't fire
  // reliably from touch, so mobile gets an explicit tap-to-add instead. A
  // simple cascading grid position is good enough — the node is draggable
  // to a better spot immediately after, same as on desktop.
  function handleAddBlockFromPalette(blockName: string) {
    if (!entry) return;
    const nodeId = freshNodeId(blockName, entry.wiring);
    const count = Object.keys(entry.wiring.nodes).length;
    const position = {
      x: 80 + (count % 4) * 200,
      y: 80 + Math.floor(count / 4) * 140,
    };
    send({
      type: "wiring.mutate",
      requestId: generateRequestId(),
      file: entry.file,
      mutation: { op: "node.add", nodeId, block: blockName, position },
    });
    setPaletteOpen(false);
  }

  function handleUndo() {
    if (!entry) return;
    navigate(entry.file, null); // the selected node may not exist post-undo
    send({
      type: "wiring.undo",
      requestId: generateRequestId(),
      file: entry.file,
    });
  }

  function handleRedo() {
    if (!entry) return;
    navigate(entry.file, null);
    send({
      type: "wiring.redo",
      requestId: generateRequestId(),
      file: entry.file,
    });
  }

  return (
    <>
      <div className="app-header">
        <span className="app-title">Flowbun</span>
        <span
          className={`connection-dot ${state.connected ? "connected" : ""}`}
          title={state.connected ? "connected" : "disconnected"}
        />
        <div className="undo-redo-group">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!entry?.undo.canUndo}
            title="Undo"
            aria-label="Undo"
          >
            ↺
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!entry?.undo.canRedo}
            title="Redo"
            aria-label="Redo"
          >
            ↻
          </button>
        </div>
        {isMobile && (
          <button
            type="button"
            className="palette-toggle"
            onClick={() => setPaletteOpen((o) => !o)}
          >
            Blocks
          </button>
        )}
        <div className="flow-tabs">
          {files.map((file) => {
            const f = state.flows.get(file);
            if (!f) return null;
            return (
              <button
                key={file}
                type="button"
                className={`flow-tab ${file === activeFile ? "active" : ""}`}
                onClick={() => navigate(file, null)}
              >
                {f.wiring.name}
                <FlowStatusBadge status={f.status} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="app-body">
        {(!isMobile || paletteOpen) && (
          <PaletteSidebar
            palette={state.palette}
            onOpenBlockEditor={setBlockEditorFile}
            onAddBlock={isMobile ? handleAddBlockFromPalette : undefined}
            onCloseMobile={isMobile ? () => setPaletteOpen(false) : undefined}
          />
        )}
        <div className="canvas-area" style={{ position: "relative" }}>
          {entry ? (
            <FlowCanvas
              file={entry.file}
              wiring={entry.wiring}
              palette={state.palette}
              onOpenBlockEditor={setBlockEditorFile}
              onSelectNode={(nodeId) => navigate(entry.file, nodeId)}
              isMobile={isMobile}
            />
          ) : (
            <div style={{ padding: 24, color: "var(--text-dim)" }}>
              No flows yet.
            </div>
          )}
          {selectedNode && selectedNodeId && entry && (
            <ConfigEditor
              nodeId={selectedNodeId}
              block={selectedNode.block}
              config={selectedNode.config}
              def={selectedDef}
              disabled={selectedNode.disabled ?? false}
              onToggleDisabled={(next) => {
                send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: {
                    op: "node.disabled",
                    nodeId: selectedNodeId,
                    disabled: next,
                  },
                });
              }}
              onClose={() => navigate(entry.file, null)}
              onOpenBlockEditor={setBlockEditorFile}
              onDelete={() => {
                send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: { op: "node.remove", nodeId: selectedNodeId },
                });
                navigate(entry.file, null);
              }}
              onSave={(config) => {
                send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: {
                    op: "node.config",
                    nodeId: selectedNodeId,
                    config,
                  },
                });
              }}
            />
          )}
        </div>
      </div>
      <LogPanel
        logs={state.logs}
        flows={[
          ...new Set([...state.flows.values()].map((f) => f.wiring.name)),
        ]}
        startCollapsed={isMobile}
      />
      {blockEditorFile && (
        <MonacoBlockEditor
          file={blockEditorFile}
          onClose={() => setBlockEditorFile(null)}
        />
      )}
    </>
  );
}

export function App() {
  return (
    <FlowbunSocketProvider>
      <Shell />
    </FlowbunSocketProvider>
  );
}
