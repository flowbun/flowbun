import { useState } from "react";
import { MonacoBlockEditor } from "./components/BlockEditor/MonacoBlockEditor";
import { FlowCanvas } from "./components/Canvas/FlowCanvas";
import { NodeInfoSheet } from "./components/Canvas/NodeInfoSheet";
import { LogPanel } from "./components/LogPanel/LogPanel";
import { ConfigEditor } from "./components/Palette/ConfigEditor";
import { PaletteSidebar } from "./components/Palette/PaletteSidebar";
import { FlowStatusBadge } from "./components/StatusBar/FlowStatusBadge";
import { useIsMobile } from "./hooks/useIsMobile";
import {
  FlowbunSocketProvider,
  useFlowbunSocket,
} from "./ws/FlowbunSocketContext";

function Shell() {
  const { state, send } = useFlowbunSocket();
  const isMobile = useIsMobile();
  const files = [...state.flows.keys()];
  const [selectedFile, setSelectedFile] = useState<string | null>(
    files[0] ?? null,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [blockEditorFile, setBlockEditorFile] = useState<string | null>(null);

  const activeFile = selectedFile ?? files[0] ?? null;
  const entry = activeFile ? state.flows.get(activeFile) : undefined;
  const selectedNode =
    selectedNodeId && entry ? entry.wiring.nodes[selectedNodeId] : undefined;
  const selectedDef = selectedNode
    ? state.palette.find((p) => p.name === selectedNode.block)
    : undefined;

  return (
    <>
      <div className="app-header">
        <span className="app-title">Flowbun</span>
        <span
          className={`connection-dot ${state.connected ? "connected" : ""}`}
          title={state.connected ? "connected" : "disconnected"}
        />
        <div className="flow-tabs">
          {files.map((file) => {
            const f = state.flows.get(file);
            if (!f) return null;
            return (
              <button
                key={file}
                type="button"
                className={`flow-tab ${file === activeFile ? "active" : ""}`}
                onClick={() => {
                  setSelectedFile(file);
                  setSelectedNodeId(null);
                }}
              >
                {f.wiring.name}
                <FlowStatusBadge status={f.status} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="app-body">
        {!isMobile && (
          <PaletteSidebar
            palette={state.palette}
            onOpenBlockEditor={setBlockEditorFile}
          />
        )}
        <div className="canvas-area" style={{ position: "relative" }}>
          {entry ? (
            <FlowCanvas
              file={entry.file}
              wiring={entry.wiring}
              palette={state.palette}
              onOpenBlockEditor={setBlockEditorFile}
              onSelectNode={setSelectedNodeId}
              readOnly={isMobile}
            />
          ) : (
            <div style={{ padding: 24, color: "var(--text-dim)" }}>
              No flows yet.
            </div>
          )}
          {selectedNode &&
            selectedNodeId &&
            entry &&
            (isMobile ? (
              <NodeInfoSheet
                nodeId={selectedNodeId}
                block={selectedNode.block}
                config={selectedNode.config}
                def={selectedDef}
                onClose={() => setSelectedNodeId(null)}
              />
            ) : (
              <ConfigEditor
                nodeId={selectedNodeId}
                config={selectedNode.config}
                defaultConfig={selectedDef?.defaultConfig}
                onClose={() => setSelectedNodeId(null)}
                onSave={(config) => {
                  send({
                    type: "wiring.mutate",
                    requestId: crypto.randomUUID(),
                    file: entry.file,
                    mutation: {
                      op: "node.config",
                      nodeId: selectedNodeId,
                      config,
                    },
                  });
                }}
              />
            ))}
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
