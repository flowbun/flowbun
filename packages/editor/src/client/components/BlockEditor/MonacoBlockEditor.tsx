import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type { TypecheckOutcome, UndoStatus } from "flowbun/ws";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useResizablePane } from "../../hooks/useResizablePane";
import { FLOWBUN_AMBIENT_TYPES } from "../../lib/flowbunAmbientTypes";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { HistoryPanel } from "../shared/HistoryPanel";
import { ResizeHandle } from "../shared/ResizeHandle";

const MIN_WIDTH = 400;
const MAX_WIDTH = 1400;

// Monaco's TS worker is a singleton shared across every MonacoBlockEditor
// mount (opening block A, closing it, opening block B all reuse the same
// worker) — register the ambient types/compiler options once, not per-mount.
let flowbunTypesRegistered = false;
const registerFlowbunTypes: BeforeMount = (monaco) => {
  if (flowbunTypesRegistered) return;
  flowbunTypesRegistered = true;
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    FLOWBUN_AMBIENT_TYPES,
    "file:///node_modules/flowbun/index.d.ts",
  );
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
  });
};

// Monaco loads from @monaco-editor/react's default CDN loader (jsdelivr) in
// this pass — self-hosting the worker assets is deferred as a later polish
// item, not silently glossed over: opening this pane for the first time
// requires outbound internet from the browser.
export function MonacoBlockEditor({
  file,
  onClose,
}: {
  file: string;
  onClose: () => void;
}) {
  const { send } = useFlowbunSocket();
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const pane = useResizablePane("flowbun.blockEditorWidth", panelRef, {
    axis: "x",
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    invert: true,
  });
  const [source, setSource] = useState<string | null>(null);
  const [typecheck, setTypecheck] = useState<TypecheckOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [undo, setUndo] = useState<UndoStatus>({
    canUndo: false,
    canRedo: false,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const loadSource = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      const r = await send({
        type: "block.read",
        requestId: generateRequestId(),
        file,
      });
      if (cancelledRef?.current) return;
      if (r.type === "block.readResult" && r.ok) {
        setSource(r.source);
        setUndo(r.undo);
      }
    },
    [file, send],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    loadSource(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [loadSource]);

  async function save(nextSource: string) {
    setSaving(true);
    try {
      const r = await send({
        type: "block.write",
        requestId: generateRequestId(),
        file,
        source: nextSource,
      });
      if (r.type === "block.writeResult") {
        setTypecheck(r.ok ? r.typecheck : { ok: false, output: r.error });
        // Biome may have reformatted the source on save (see ws-server.ts) —
        // reflect the actual on-disk text back into the editor so the
        // buffer never silently diverges from what was written.
        if (r.ok) {
          setSource(r.source);
          setUndo(r.undo);
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function undoOrRedo(kind: "block.undo" | "block.redo") {
    const r = await send({ type: kind, requestId: generateRequestId(), file });
    if (r.type === "block.undoResult" || r.type === "block.redoResult") {
      if (r.ok) {
        setSource(r.source);
        setTypecheck(r.typecheck);
        setUndo(r.undo);
      }
    }
  }

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    // Without this, DOM focus stays wherever it was before the panel opened
    // (e.g. the node the user double-clicked) — the first keystrokes then
    // land on whatever's behind this overlay (the still-mounted FlowCanvas)
    // instead of Monaco, most noticeably swallowing Space since ReactFlow
    // treats it as its pan-activation key by default.
    editorInstance.focus();
    // Ctrl/Cmd+S has no reliable equivalent from a mobile virtual keyboard —
    // the header's Save button (below) is the primary path there, but this
    // still works wherever a real keyboard is attached.
    editorInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        save(editorInstance.getValue());
      },
    );
  };

  return (
    <div
      className="block-editor-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${file}`}
    >
      <div
        ref={panelRef}
        className="block-editor-panel"
        style={
          !isMobile && pane.size !== undefined
            ? { width: pane.size }
            : undefined
        }
      >
        {!isMobile && (
          <ResizeHandle
            orientation="vertical"
            pane={pane}
            label="Resize block editor"
          />
        )}
        <div className="block-editor-header">
          <strong>{file}</strong>
          <div className="block-editor-actions">
            <button
              type="button"
              onClick={() => undoOrRedo("block.undo")}
              disabled={!undo.canUndo}
              title="Undo"
              aria-label="Undo"
            >
              ↺
            </button>
            <button
              type="button"
              onClick={() => undoOrRedo("block.redo")}
              disabled={!undo.canRedo}
              title="Redo"
              aria-label="Redo"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              title="History"
              aria-label="History"
            >
              🕘
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const value = editorRef.current?.getValue();
                if (value !== undefined) save(value);
              }}
            >
              Save
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="block-editor-body">
          <Editor
            language="typescript"
            theme="vs-dark"
            path={file}
            value={source ?? ""}
            beforeMount={registerFlowbunTypes}
            onMount={handleMount}
            // Without this, closing the panel synchronously disposes the
            // text model (@monaco-editor/react's default unmount
            // behavior). Monaco's TS worker runs semantic-diagnostics
            // validation on the model asynchronously (independent of
            // onValidate being wired up), and if that resolves after the
            // model is gone, it throws from inside the CDN-loaded,
            // cross-origin Monaco bundle — which the browser reports with
            // no stack as a bare, persistent "Script error." Keeping the
            // model alive (only the editor widget itself gets disposed)
            // means that in-flight worker callback still has something
            // valid to apply markers to. Trade-off: models for every
            // block ever opened this session stay in memory rather than
            // being freed on close — acceptable here given how few
            // distinct block files a flowbun instance actually has.
            keepCurrentModel
            options={{
              automaticLayout: true,
              wordWrap: "on",
              fontSize: isMobile ? 14 : 13,
              minimap: { enabled: !isMobile },
            }}
          />
        </div>
        {saving && <div className="typecheck-ok">saving…</div>}
        {typecheck &&
          !saving &&
          (typecheck.ok ? (
            <div className="typecheck-ok">typecheck OK</div>
          ) : (
            <pre className="typecheck-error">{typecheck.output}</pre>
          ))}
      </div>
      {historyOpen && (
        <HistoryPanel
          kind="block"
          file={file}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => loadSource()}
        />
      )}
    </div>
  );
}
