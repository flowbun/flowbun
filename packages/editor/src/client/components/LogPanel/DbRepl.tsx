import type { DbQueryOutcome } from "flowbun/ws";
import { useEffect, useRef, useState } from "react";
import { usePersistedState } from "../../hooks/usePersistedState";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";

const MAX_COMMAND_HISTORY = 100;

interface HistoryEntry {
  id: number;
  sql: string;
  result?: DbQueryOutcome;
  error?: string;
}

function formatCell(cell: unknown): string {
  if (cell === null) return "NULL";
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

function ResultView({ result }: { result: DbQueryOutcome }) {
  if (result.columns.length === 0) {
    return (
      <div className="db-repl-meta">
        {result.changes !== undefined
          ? `${result.changes} row${result.changes === 1 ? "" : "s"} affected`
          : "OK"}
        {result.lastInsertRowid !== undefined &&
          result.lastInsertRowid !== "0" &&
          ` — last insert rowid ${result.lastInsertRowid}`}
      </div>
    );
  }
  if (result.rowCount === 0) {
    return <div className="db-repl-meta">0 rows</div>;
  }
  return (
    <div className="db-repl-table-wrap">
      <table className="db-repl-table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id, this is a fresh render of one immutable query result
            <tr key={i}>
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells have no stable id, same immutable-result reasoning as the row key above
                <td key={j}>{formatCell(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="db-repl-meta">
        {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
      </div>
    </div>
  );
}

/**
 * A REPL against the coordinator's state database (data/state/flowbun.sqlite)
 * — genuinely arbitrary SQL, not a canned query picker, run via the
 * "db.query" ws message (see coordinator/src/db-repl.ts). Command history
 * (↑/↓, like a real shell) persists across reloads; the output log itself
 * doesn't — it's this session's scrollback, not durable state.
 */
export function DbRepl() {
  const { send } = useFlowbunSocket();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [input, setInput] = useState("");
  const [commandHistory, setCommandHistory] = usePersistedState<string[]>(
    "flowbun.dbRepl.commandHistory",
    [],
  );
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const nextId = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: history is intentionally re-trigger-only — scrolls the DOM via outputRef, not read directly, but must rerun every time a new entry is appended.
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [history]);

  async function runQuery(sql: string) {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    const r = await send({
      type: "db.query",
      requestId: generateRequestId(),
      sql: trimmed,
    });
    const entry: HistoryEntry = { id: nextId.current++, sql: trimmed };
    if (r.type !== "db.queryResult") {
      entry.error = "unexpected response from server";
    } else if (r.ok) {
      entry.result = r;
    } else {
      entry.error = r.error;
    }
    setHistory((h) => [...h, entry]);
    setCommandHistory((h) =>
      h[h.length - 1] === trimmed
        ? h
        : [...h, trimmed].slice(-MAX_COMMAND_HISTORY),
    );
    setInput("");
    setHistoryIndex(null);
    setRunning(false);
    // The textarea is never actually disabled (see its own comment below),
    // so this is belt-and-braces rather than working around a forced
    // blur — but explicit is cheap, and it's what makes "keep typing the
    // next command" actually work if focus ever does end up elsewhere.
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runQuery(input);
      return;
    }
    // Command-history recall only when there's nothing to navigate within
    // the input itself — a multi-line draft shouldn't have its cursor
    // movement hijacked by ↑/↓.
    if (input.includes("\n")) return;
    if (e.key === "ArrowUp") {
      if (commandHistory.length === 0) return;
      e.preventDefault();
      const next =
        historyIndex === null
          ? commandHistory.length - 1
          : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(commandHistory[next] ?? "");
    } else if (e.key === "ArrowDown") {
      if (historyIndex === null) return;
      e.preventDefault();
      const next = historyIndex + 1;
      if (next >= commandHistory.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(commandHistory[next] ?? "");
      }
    }
  }

  return (
    <div className="db-repl">
      <div className="db-repl-output" ref={outputRef}>
        {history.length === 0 && (
          <div className="db-repl-hint">
            Query <code>data/state/flowbun.sqlite</code> directly — the same
            database blocks read/write via <code>ctx.state</code>. Try{" "}
            <code>SELECT * FROM state LIMIT 20;</code>
          </div>
        )}
        {history.map((entry) => (
          <div key={entry.id} className="db-repl-entry">
            <div className="db-repl-command">&gt; {entry.sql}</div>
            {entry.error && <div className="db-repl-error">{entry.error}</div>}
            {entry.result && <ResultView result={entry.result} />}
          </div>
        ))}
      </div>
      <textarea
        ref={inputRef}
        className="db-repl-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="SQL — Enter to run, Shift+Enter for a newline, ↑/↓ for history"
        rows={2}
        // Deliberately not `disabled={running}` — disabling a focused
        // element forces an immediate browser-level blur, and re-enabling
        // it afterwards does not restore focus. runQuery's own `running`
        // check already prevents a second query firing while one is in
        // flight, so disabling here would only cost focus for no benefit.
      />
    </div>
  );
}
