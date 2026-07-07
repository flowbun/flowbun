import type { LogRecord } from "flowbun/ipc";
import { useMemo, useState } from "react";

export function LogPanel({
  logs,
  flows,
  startCollapsed = false,
}: {
  logs: LogRecord[];
  flows: string[];
  startCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const [flowFilter, setFlowFilter] = useState<string>("");
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [text, setText] = useState("");

  const filtered = useMemo(() => {
    return logs.filter((e) => {
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
  }, [logs, flowFilter, levelFilter, text]);

  return (
    <div className={`log-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="log-panel-header">
        <button type="button" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▲" : "▼"} Logs ({filtered.length})
        </button>
        {!collapsed && (
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
          </>
        )}
      </div>
      {!collapsed && (
        <div className="log-entries">
          {filtered.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: log entries have no stable id, this list is append-only-ish and never reordered
            <div key={`${e.at}-${i}`} className="log-entry">
              <span className={`level-${e.level}`}>[{e.level}]</span> {e.flow}
              {e.nodeId ? `/${e.nodeId}` : ""} — {e.msg}
              {e.meta ? ` ${JSON.stringify(e.meta)}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
