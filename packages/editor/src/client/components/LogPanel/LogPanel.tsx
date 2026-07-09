import type { LogRecord } from "flowbun/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePersistedState } from "../../hooks/usePersistedState";
import { useResizablePane } from "../../hooks/useResizablePane";
import { ResizeHandle } from "../shared/ResizeHandle";
import { DbRepl } from "./DbRepl";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;
// Slack for "is the user at the bottom" — scrollHeight/scrollTop are
// fractional in some browsers, so an exact-zero check would flicker
// auto-scroll off on a settled, genuinely-at-bottom panel.
const AT_BOTTOM_THRESHOLD_PX = 8;

type Tab = "logs" | "db";

function formatTimestamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function LogPanel({
  logs,
  flows,
  startCollapsed = false,
}: {
  logs: LogRecord[];
  flows: string[];
  startCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = usePersistedState(
    "flowbun.logPanel.collapsed",
    startCollapsed,
  );
  const [activeTab, setActiveTab] = usePersistedState<Tab>(
    "flowbun.logPanel.activeTab",
    "logs",
  );
  const [flowFilter, setFlowFilter] = usePersistedState(
    "flowbun.logPanel.flowFilter",
    "",
  );
  const [levelFilter, setLevelFilter] = usePersistedState(
    "flowbun.logPanel.levelFilter",
    "",
  );
  const [text, setText] = usePersistedState("flowbun.logPanel.textFilter", "");
  // Deliberately NOT persisted, unlike the filters above — "Clear" means
  // "hide what's already on screen right now," not a durable preference;
  // persisting it would hide everything before that timestamp forever,
  // including on a totally different day after a reload.
  const [clearedAt, setClearedAt] = useState(0);
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  // The handle sits on the panel's TOP edge, but the panel itself grows
  // upward from the bottom of the screen — dragging up (a smaller/negative
  // pointer delta) should GROW it, the opposite of the palette sidebar's
  // right-edge handle, hence invert.
  const pane = useResizablePane("flowbun.logPanelHeight", ref, {
    axis: "y",
    min: MIN_HEIGHT,
    max: MAX_HEIGHT,
    invert: true,
  });

  const filtered = useMemo(() => {
    return logs.filter((e) => {
      if (e.at <= clearedAt) return false;
      if (flowFilter && e.flow !== flowFilter) return false;
      if (levelFilter && e.level !== levelFilter) return false;
      if (
        text &&
        !e.msg.toLowerCase().includes(text.toLowerCase()) &&
        !JSON.stringify(e.meta ?? {})
          .toLowerCase()
          .includes(text.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [logs, flowFilter, levelFilter, text, clearedAt]);

  // Starts true (a freshly opened log panel should show the latest entries,
  // same as tailing a file) — flips off the moment the user's own scrolling
  // leaves the bottom, and back on once they scroll back to it themselves.
  // Never toggled directly by new entries arriving, only by handleScroll.
  const [autoScroll, setAutoScroll] = useState(true);
  const entriesRef = useRef<HTMLDivElement>(null);

  function handleScroll() {
    const el = entriesRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      AT_BOTTOM_THRESHOLD_PX;
    setAutoScroll(atBottom);
  }

  // Re-pins to the bottom whenever the visible list grows or changes (new
  // entries, a filter narrowing/widening it, Clear) — but only while
  // autoScroll is still on; a user who's scrolled up to read history is
  // never yanked back down. Also fires when the panel re-expands from
  // collapsed (the entries div unmounts/remounts, so its own scrollTop
  // resets to 0), landing it back at the bottom to match autoScroll's
  // default.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filtered/collapsed are intentionally re-trigger-only — the effect reads the DOM via entriesRef, not these values directly, but must rerun whenever either changes.
  useEffect(() => {
    if (!autoScroll) return;
    const el = entriesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll, collapsed]);

  // Tab buttons double as the panel's expand control — picking a tab
  // always reveals it (per the whole point of putting a "DB" button next
  // to "Logs" on a collapsed panel: something to click to reveal it). The
  // separate chevron button below is the only way to collapse.
  function selectTab(tab: Tab) {
    setActiveTab(tab);
    setCollapsed(false);
  }

  return (
    <div
      ref={ref}
      className={`log-panel ${collapsed ? "collapsed" : ""}`}
      style={
        !collapsed && !isMobile && pane.size !== undefined
          ? { height: pane.size }
          : undefined
      }
    >
      {!collapsed && !isMobile && (
        <ResizeHandle
          orientation="horizontal"
          pane={pane}
          label="Resize log panel"
        />
      )}
      <div className="log-panel-header">
        <button
          type="button"
          className="log-panel-collapse-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand panel" : "Collapse panel"}
          title={collapsed ? "Expand panel" : "Collapse panel"}
        >
          {collapsed ? "▲" : "▼"}
        </button>
        <button
          type="button"
          className={`log-panel-tab ${activeTab === "logs" ? "active" : ""}`}
          onClick={() => selectTab("logs")}
        >
          Logs ({filtered.length})
        </button>
        <button
          type="button"
          className={`log-panel-tab ${activeTab === "db" ? "active" : ""}`}
          onClick={() => selectTab("db")}
        >
          DB
        </button>
        {!collapsed && activeTab === "logs" && (
          <>
            <select
              value={flowFilter}
              onChange={(e) => setFlowFilter(e.target.value)}
            >
              <option value="">all flows</option>
              {flows.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="">all levels</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
            <input
              type="text"
              placeholder="filter…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="button"
              className="log-clear-button"
              onClick={() => setClearedAt(Date.now())}
            >
              Clear
            </button>
          </>
        )}
      </div>
      {!collapsed && activeTab === "logs" && (
        <div ref={entriesRef} className="log-entries" onScroll={handleScroll}>
          {filtered.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: log entries have no stable id, this list is append-only-ish and never reordered
            <div key={`${e.at}-${i}`} className="log-entry">
              <span className="log-time">{formatTimestamp(e.at)}</span>{" "}
              <span className={`level-${e.level}`}>[{e.level}]</span> {e.flow}
              {e.nodeId ? `/${e.nodeId}` : ""} — {e.msg}
              {e.meta ? ` ${JSON.stringify(e.meta)}` : ""}
            </div>
          ))}
        </div>
      )}
      {!collapsed && activeTab === "db" && <DbRepl />}
    </div>
  );
}
