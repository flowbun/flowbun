import type { HistoryEntry } from "flowbun/ws";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Arbitrary point-in-time rollback, backed directly by git-snapshot.ts's
 * commit log (see history.list/history.restore in ws-server.ts) — a
 * superset of the undo/redo buttons, which only ever step one commit at a
 * time. Restoring is always a new forward commit, never a destructive git
 * reset, so nothing here can ever lose history.
 */
export function HistoryPanel({
  kind,
  file,
  onClose,
  onRestored,
}: {
  kind: "wiring" | "block";
  file: string;
  onClose: () => void;
  /** Called after a successful restore, before the panel closes — lets the
   * caller refresh whatever local copy of the content it's holding (blocks
   * have no broadcast channel the way wiring files do; see block.readResult's
   * own comment in protocol.ts). */
  onRestored?: () => void;
}) {
  const { send } = useFlowbunSocket();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringHash, setRestoringHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    send({
      type: "history.list",
      requestId: generateRequestId(),
      kind,
      file,
    }).then((r) => {
      if (cancelled) return;
      if (r.type !== "history.listResult") return;
      if (r.ok) setEntries(r.entries);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, file, send]);

  async function restore(hash: string) {
    if (restoringHash) return;
    setRestoringHash(hash);
    setError(null);
    try {
      const r = await send({
        type: "history.restore",
        requestId: generateRequestId(),
        kind,
        file,
        hash,
      });
      if (r.type !== "history.restoreResult") return;
      if (r.ok) {
        onRestored?.();
        onClose();
      } else {
        setError(r.error);
      }
    } finally {
      setRestoringHash(null);
    }
  }

  return createPortal(
    <div
      className="create-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`History for ${file}`}
    >
      <div className="create-dialog-panel history-panel">
        <h3>History: {file}</h3>
        {entries === null && !error && (
          <div className="history-panel-loading">Loading…</div>
        )}
        {error && <div className="create-dialog-error">{error}</div>}
        {entries && entries.length === 0 && (
          <div className="history-panel-empty">
            No history yet — this file has only ever been saved once.
          </div>
        )}
        {entries && entries.length > 0 && (
          <div className="history-panel-list">
            {entries.map((entry, i) => (
              <div key={entry.hash} className="history-panel-entry">
                <div className="history-panel-entry-info">
                  <span className="history-panel-entry-message">
                    {entry.message}
                  </span>
                  <span className="history-panel-entry-date">
                    {formatHistoryDate(entry.date)}
                  </span>
                </div>
                <button
                  type="button"
                  className="history-panel-restore"
                  disabled={i === 0 || restoringHash !== null}
                  onClick={() => restore(entry.hash)}
                  title={
                    i === 0
                      ? "Already the current version"
                      : "Restore this version"
                  }
                >
                  {restoringHash === entry.hash ? "Restoring…" : "Restore"}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="create-dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
