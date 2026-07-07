import Editor from "@monaco-editor/react";
import type { TypecheckOutcome } from "flowbun/ws";
import { useEffect, useState } from "react";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

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
  const [source, setSource] = useState<string | null>(null);
  const [typecheck, setTypecheck] = useState<TypecheckOutcome | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    send({ type: "block.read", requestId: crypto.randomUUID(), file }).then(
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
        requestId: crypto.randomUUID(),
        file,
        source: nextSource,
      });
      if (r.type === "block.writeResult") {
        setTypecheck(r.ok ? r.typecheck : { ok: false, output: r.error });
      }
    } finally {
      setSaving(false);
    }
  }

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
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <Editor
          height="60vh"
          language="typescript"
          theme="vs-dark"
          value={source ?? ""}
          onMount={(editorInstance, monaco) => {
            editorInstance.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
              () => {
                save(editorInstance.getValue());
              },
            );
          }}
        />
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
