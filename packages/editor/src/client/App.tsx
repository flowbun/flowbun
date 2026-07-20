import { useEffect, useRef, useState } from "react";
import { LoginGate } from "./components/Auth/LoginGate";
import { MonacoBlockEditor } from "./components/BlockEditor/MonacoBlockEditor";
import { FlowCanvas } from "./components/Canvas/FlowCanvas";
import { ChatPanel } from "./components/ChatPanel/ChatPanel";
import { LogPanel } from "./components/LogPanel/LogPanel";
import { NewBlockDialog } from "./components/NewBlock/NewBlockDialog";
import { NewFlowDialog } from "./components/NewFlow/NewFlowDialog";
import { ConfigEditor } from "./components/Palette/ConfigEditor";
import { PaletteSidebar } from "./components/Palette/PaletteSidebar";
import { FlowDetailModal } from "./components/StatusBar/FlowDetailModal";
import { StatusDot } from "./components/StatusBar/StatusDot";
import { ConfirmDialog } from "./components/shared/ConfirmDialog";
import { HistoryPanel } from "./components/shared/HistoryPanel";
import { ResizeHandle } from "./components/shared/ResizeHandle";
import { SystemStatsModal } from "./components/shared/SystemStatsModal";
import { useIsMobile } from "./hooks/useIsMobile";
import { usePersistedState } from "./hooks/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { freshNodeId } from "./lib/freshNodeId";
import { generateRequestId } from "./lib/requestId";
import { navigate, useRoute } from "./lib/route";
import {
  FlowbunSocketProvider,
  useFlowbunSocket,
} from "./ws/FlowbunSocketContext";

const MIN_HEADER_HEIGHT = 40;
const MAX_HEADER_HEIGHT = 160;

function Shell() {
  const { state, send } = useFlowbunSocket();
  const isMobile = useIsMobile();
  const headerRef = useRef<HTMLDivElement>(null);
  const headerPane = useResizablePane("flowbun.headerHeight", headerRef, {
    axis: "y",
    min: MIN_HEADER_HEIGHT,
    max: MAX_HEADER_HEIGHT,
  });
  const route = useRoute();
  const files = [...state.flows.keys()];
  const [blockEditorFile, setBlockEditorFile] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFlowOpen, setNewFlowOpen] = useState(false);
  const [newBlockOpen, setNewBlockOpen] = useState(false);
  const [deleteBlockTarget, setDeleteBlockTarget] = useState<{
    file: string;
    name: string;
  } | null>(null);
  const [deleteFlowTarget, setDeleteFlowTarget] = useState<{
    file: string;
    name: string;
  } | null>(null);
  const [flowDetailFile, setFlowDetailFile] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = usePersistedState(
    "flowbun.chatPanel.open",
    !isMobile,
  );

  const activeFile = route.file ?? files[0] ?? null;
  const selectedNodeId = route.file ? route.nodeId : null;
  const entry = activeFile ? state.flows.get(activeFile) : undefined;
  const selectedNode =
    selectedNodeId && entry ? entry.wiring.nodes[selectedNodeId] : undefined;
  const selectedDef = selectedNode
    ? state.palette.find((p) => p.name === selectedNode.block)
    : undefined;
  const flowDetailEntry = flowDetailFile
    ? state.flows.get(flowDetailFile)
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
      <div
        ref={headerRef}
        className="app-header"
        style={
          headerPane.size !== undefined
            ? { height: headerPane.size }
            : undefined
        }
      >
        <ResizeHandle
          orientation="horizontal"
          pane={headerPane}
          label="Resize header"
        />
        <button
          type="button"
          className="app-title"
          onClick={() => setStatsOpen(true)}
          title="System stats"
        >
          Flowbun
        </button>
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
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            disabled={!entry}
            title="History"
            aria-label="History"
          >
            🕘
          </button>
          <button
            type="button"
            className={chatOpen ? "active" : ""}
            onClick={() => setChatOpen((o) => !o)}
            title="Chat with Claude"
            aria-label="Chat with Claude"
            aria-pressed={chatOpen}
          >
            💬
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
              <div
                key={file}
                className={`flow-tab ${file === activeFile ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="flow-tab-main"
                  onClick={() => navigate(file, null)}
                  onDoubleClick={() => setFlowDetailFile(file)}
                  title="Double-click for details"
                >
                  <StatusDot status={f.status} />
                  {f.wiring.name}
                </button>
                <button
                  type="button"
                  className="flow-tab-delete"
                  onClick={() =>
                    setDeleteFlowTarget({ file, name: f.wiring.name })
                  }
                  title="Delete flow"
                  aria-label={`Delete ${f.wiring.name}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="new-resource-button"
          onClick={() => setNewFlowOpen(true)}
          title="New flow"
          aria-label="New flow"
        >
          + Flow
        </button>
      </div>
      <div className="app-body">
        {(!isMobile || paletteOpen) && (
          <PaletteSidebar
            palette={state.palette}
            onOpenBlockEditor={setBlockEditorFile}
            onDeleteBlock={(file, name) => setDeleteBlockTarget({ file, name })}
            onAddBlock={isMobile ? handleAddBlockFromPalette : undefined}
            onCloseMobile={isMobile ? () => setPaletteOpen(false) : undefined}
            onNewBlock={() => setNewBlockOpen(true)}
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
              key={selectedNodeId}
              nodeId={selectedNodeId}
              block={selectedNode.block}
              config={selectedNode.config}
              def={selectedDef}
              disabled={selectedNode.disabled ?? false}
              onToggleDisabled={async (next) => {
                const r = await send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: {
                    op: "node.disabled",
                    nodeId: selectedNodeId,
                    disabled: next,
                  },
                });
                return r.type === "wiring.mutateResult"
                  ? r
                  : { ok: false, error: "unexpected response from server" };
              }}
              onClose={() => navigate(entry.file, null)}
              onOpenBlockEditor={setBlockEditorFile}
              onDelete={async () => {
                const r = await send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: { op: "node.remove", nodeId: selectedNodeId },
                });
                const result: { ok: boolean; error?: string } =
                  r.type === "wiring.mutateResult"
                    ? r
                    : { ok: false, error: "unexpected response from server" };
                if (result.ok) navigate(entry.file, null);
                return result;
              }}
              onSave={async (config) => {
                const r = await send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: {
                    op: "node.config",
                    nodeId: selectedNodeId,
                    config,
                  },
                });
                return r.type === "wiring.mutateResult"
                  ? r
                  : { ok: false, error: "unexpected response from server" };
              }}
              onRename={async (newNodeId) => {
                const r = await send({
                  type: "wiring.mutate",
                  requestId: generateRequestId(),
                  file: entry.file,
                  mutation: {
                    op: "node.rename",
                    nodeId: selectedNodeId,
                    newNodeId,
                  },
                });
                const result: { ok: boolean; error?: string } =
                  r.type === "wiring.mutateResult"
                    ? r
                    : { ok: false, error: "unexpected response from server" };
                // The old id no longer exists once this succeeds — follow
                // the rename so the panel keeps showing the same node
                // instead of pointing at an id that just vanished.
                if (result.ok) navigate(entry.file, newNodeId);
                return result;
              }}
            />
          )}
        </div>
        <ChatPanel
          chatEvents={state.chatEvents}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          currentFlow={activeFile}
        />
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
      {deleteBlockTarget && (
        <ConfirmDialog
          title="Delete block"
          message={
            <>
              Delete <code>{deleteBlockTarget.name}</code>? This removes its
              source file and can't be undone. Blocks still in use by a node
              can't be deleted.
            </>
          }
          confirmLabel="Delete"
          onClose={() => setDeleteBlockTarget(null)}
          onConfirm={async () => {
            const r = await send({
              type: "block.delete",
              requestId: generateRequestId(),
              file: deleteBlockTarget.file,
            });
            if (r.type !== "block.deleteResult") {
              return { ok: false, error: "unexpected response from server" };
            }
            return r;
          }}
        />
      )}
      {deleteFlowTarget && (
        <ConfirmDialog
          title="Delete flow"
          message={
            <>
              Delete <code>{deleteFlowTarget.name}</code>? This removes its
              wiring file and stops it running — can't be undone.
            </>
          }
          confirmLabel="Delete"
          onClose={() => setDeleteFlowTarget(null)}
          onConfirm={async () => {
            const r = await send({
              type: "flow.delete",
              requestId: generateRequestId(),
              file: deleteFlowTarget.file,
            });
            if (r.type !== "flow.deleteResult") {
              return { ok: false, error: "unexpected response from server" };
            }
            return r;
          }}
        />
      )}
      {flowDetailEntry && (
        <FlowDetailModal
          entry={flowDetailEntry}
          onClose={() => setFlowDetailFile(null)}
          onToggleDisabled={async (next) => {
            const r = await send({
              type: "wiring.mutate",
              requestId: generateRequestId(),
              file: flowDetailEntry.file,
              mutation: { op: "flow.disabled", disabled: next },
            });
            return r.type === "wiring.mutateResult"
              ? r
              : { ok: false, error: "unexpected response from server" };
          }}
        />
      )}
      {statsOpen && <SystemStatsModal onClose={() => setStatsOpen(false)} />}
      {historyOpen && entry && (
        <HistoryPanel
          kind="wiring"
          file={entry.file}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {newFlowOpen && <NewFlowDialog onClose={() => setNewFlowOpen(false)} />}
      {newBlockOpen && (
        <NewBlockDialog
          onClose={() => setNewBlockOpen(false)}
          onCreated={(file) => {
            setNewBlockOpen(false);
            setBlockEditorFile(file);
          }}
        />
      )}
    </>
  );
}

export function App() {
  return (
    <LoginGate>
      <FlowbunSocketProvider>
        <Shell />
      </FlowbunSocketProvider>
    </LoginGate>
  );
}
