import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type { TypecheckOutcome } from "flowbun/ws";
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { FLOWBUN_AMBIENT_TYPES } from "../../lib/flowbunAmbientTypes";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

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
  const [source, setSource] = useState<string | null>(null);
  const [typecheck, setTypecheck] = useState<TypecheckOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    let cancelled = false;
    send({ type: "block.read", requestId: generateRequestId(), file }).then(
      (r) => {
        if (cancelled) return;
        if (r.type === "block.readResult" && r.ok) setSource(r.source);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file, send]);

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
        if (r.ok) setSource(r.source);
      }
    } finally {
      setSaving(false);
    }
  }

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
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
      <div className="block-editor-panel">
        <div className="block-editor-header">
          <strong>{file}</strong>
          <div className="block-editor-actions">
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
    </div>
  );
}
