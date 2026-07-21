import type { SystemStats } from "flowbun/ws";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "../../lib/formatBytes";
import { formatDuration } from "../../lib/formatDuration";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

const REFRESH_INTERVAL_MS = 2000;

function statusSummary(byStatus: Record<string, number>): string {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return "none";
  return entries.map(([kind, count]) => `${count} ${kind}`).join(", ");
}

/**
 * Opened by clicking the "Flowbun" title — a snapshot of coordinator and
 * system telemetry, re-fetched on an interval while open for a live feel
 * (memory/uptime/load actually ticking), not pushed from the server: this
 * is a "check in on it" view, not something worth a permanent broadcast
 * subscription for.
 */
export function SystemStatsModal({
  onClose,
  onManagePackages,
}: {
  onClose: () => void;
  onManagePackages: () => void;
}) {
  const { send } = useFlowbunSocket();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      const r = await send({
        type: "system.stats",
        requestId: generateRequestId(),
      });
      if (cancelled) return;
      if (r.type !== "system.statsResult") {
        setError("unexpected response from server");
        return;
      }
      if (r.ok) {
        setStats(r.stats);
        setError(null);
      } else {
        setError(r.error);
      }
    }
    fetchStats();
    const interval = setInterval(fetchStats, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [send]);

  return createPortal(
    <div
      className="create-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="System stats"
    >
      <div className="create-dialog-panel">
        <h3>System stats</h3>
        {error && <div className="create-dialog-error">{error}</div>}
        {stats && (
          <>
            <h4 className="detail-section-title">Coordinator</h4>
            <div className="detail-rows">
              <div className="detail-row">
                <span className="detail-label">Bun version</span>
                <span>{stats.coordinator.bunVersion}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">PID</span>
                <span>{stats.coordinator.pid}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Uptime</span>
                <span>{formatDuration(stats.coordinator.uptimeSec)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Memory (RSS)</span>
                <span>{formatBytes(stats.coordinator.memory.rss)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Heap used / total</span>
                <span>
                  {formatBytes(stats.coordinator.memory.heapUsed)} /{" "}
                  {formatBytes(stats.coordinator.memory.heapTotal)}
                </span>
              </div>
            </div>

            <h4 className="detail-section-title">
              Processes &amp; connections
            </h4>
            <div className="detail-rows">
              <div className="detail-row">
                <span className="detail-label">Bun processes running</span>
                <span>{stats.bunProcessCount}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">WebSocket clients</span>
                <span>{stats.websocket.connectedClients}</span>
              </div>
            </div>

            <h4 className="detail-section-title">Flows &amp; data</h4>
            <div className="detail-rows">
              <div className="detail-row">
                <span className="detail-label">Flows</span>
                <span>
                  {stats.flows.total} ({statusSummary(stats.flows.byStatus)})
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Blocks in palette</span>
                <span>{stats.palette.blockCount}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Log buffer</span>
                <span>{stats.logBuffer.size} entries</span>
              </div>
            </div>

            <h4 className="detail-section-title">Host system</h4>
            <div className="detail-rows">
              <div className="detail-row">
                <span className="detail-label">Memory used</span>
                <span>
                  {formatBytes(
                    stats.system.totalMemBytes - stats.system.freeMemBytes,
                  )}{" "}
                  / {formatBytes(stats.system.totalMemBytes)}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">CPU cores</span>
                <span>{stats.system.cpuCount}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Load average (1/5/15m)</span>
                <span>
                  {stats.system.loadAvg.map((n) => n.toFixed(2)).join(" / ")}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">System uptime</span>
                <span>{formatDuration(stats.system.uptimeSec)}</span>
              </div>
            </div>
          </>
        )}
        {!stats && !error && <div className="detail-label">Loading…</div>}
        <div className="create-dialog-actions">
          <button type="button" onClick={onManagePackages}>
            Manage packages…
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
