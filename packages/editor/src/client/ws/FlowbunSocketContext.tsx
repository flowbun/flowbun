import type { LogRecord } from "flowbun/ipc";
import type {
  BlockPaletteEntry,
  ClientToServer,
  FlowEntry,
  ServerToClient,
} from "flowbun/ws";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { logToDevtoolsConsole } from "../devtools-console";

interface State {
  connected: boolean;
  flows: Map<string, FlowEntry>;
  palette: BlockPaletteEntry[];
  logs: LogRecord[];
  /** Keyed by `${flow}::${nodeId}` — last time that node's block.process()
   * was invoked, derived from "router.deliver" log entries (see
   * applyLastProcessed below). Tracked separately from `logs` since the log
   * array is capped/trimmed and shouldn't be scanned per-render just to
   * find one node's last-active time. */
  lastProcessed: Map<string, number>;
  /** Keyed by `${flow}::${nodeId}.${port}` — a version stamp (the
   * producing message's router seq) that changes every time that node's
   * output port fires, derived from "router.produced" log entries (see
   * applyActivity below). Wire-activity dots (DeletableEdge) watch their own
   * wire's source key and spawn a new travelling dot whenever it changes —
   * a Map of "latest version" rather than a queue of every event, so a
   * consumer that was unmounted (e.g. a different flow tab was active) just
   * sees the latest state on remount instead of replaying a backlog. */
  activity: Map<string, number>;
}

type Action =
  | { type: "server"; msg: ServerToClient }
  | { type: "connected"; value: boolean };

const MAX_CLIENT_LOGS = 2000;

export function lastProcessedKey(flow: string, nodeId: string): string {
  return `${flow}::${nodeId}`;
}

export function activityKey(
  flow: string,
  nodeId: string,
  port: string,
): string {
  return `${flow}::${nodeId}.${port}`;
}

/** router.deliver fires (runtime/src/router/router.ts) right before every
 * enabled node's block.process() is invoked, unconditionally — the closest
 * thing to a "block processed a message" event already on the wire. */
function applyLastProcessed(
  map: Map<string, number>,
  entry: LogRecord,
): Map<string, number> {
  if (entry.msg !== "router.deliver" || !entry.nodeId) return map;
  const key = lastProcessedKey(entry.flow, entry.nodeId);
  if ((map.get(key) ?? 0) >= entry.at) return map;
  const next = new Map(map);
  next.set(key, entry.at);
  return next;
}

/** router.produced fires (runtime/src/router/router.ts) right after a
 * node's block.process() returns, carrying every output port it set —
 * `outputs[port] === undefined` means that port didn't actually fire this
 * time (the router itself skips fanning those out), so skip them here too.
 * The router's own per-flow seq number is used as the version stamp rather
 * than `entry.at`, since it's guaranteed strictly increasing with no
 * same-millisecond collisions. */
function applyActivity(
  map: Map<string, number>,
  entry: LogRecord,
): Map<string, number> {
  if (entry.msg !== "router.produced") return map;
  const meta = entry.meta as
    | { node?: string; outputs?: Record<string, unknown>; seq?: number }
    | undefined;
  if (!meta?.node || !meta.outputs) return map;
  let next: Map<string, number> | undefined;
  for (const [port, value] of Object.entries(meta.outputs)) {
    if (value === undefined) continue;
    const key = activityKey(entry.flow, meta.node, port);
    const version = meta.seq ?? entry.at;
    if (map.get(key) === version) continue;
    next = new Map(next ?? map);
    next.set(key, version);
  }
  return next ?? map;
}

function reducer(state: State, action: Action): State {
  if (action.type === "connected") return { ...state, connected: action.value };
  const msg = action.msg;
  switch (msg.type) {
    case "snapshot": {
      let lastProcessed = state.lastProcessed;
      let activity = state.activity;
      for (const entry of msg.logs) {
        lastProcessed = applyLastProcessed(lastProcessed, entry);
        activity = applyActivity(activity, entry);
      }
      return {
        ...state,
        flows: new Map(msg.flows.map((f) => [f.file, f])),
        palette: msg.palette,
        logs: msg.logs,
        lastProcessed,
        activity,
      };
    }
    case "flow.updated": {
      const flows = new Map(state.flows);
      const prev = flows.get(msg.file);
      flows.set(msg.file, {
        file: msg.file,
        wiring: msg.wiring,
        status: prev?.status ?? { kind: "starting" },
        undo: msg.undo,
      });
      return { ...state, flows };
    }
    case "flow.status": {
      const flows = new Map(state.flows);
      for (const [file, entry] of flows) {
        if (entry.wiring.name === msg.flow)
          flows.set(file, { ...entry, status: msg.status });
      }
      return { ...state, flows };
    }
    case "flow.removed": {
      const flows = new Map(state.flows);
      flows.delete(msg.file);
      return { ...state, flows };
    }
    case "palette.updated":
      return { ...state, palette: msg.palette };
    case "log":
      // Stage 2's hard requirement: unconditional, independent of whether
      // the LogPanel is even mounted.
      logToDevtoolsConsole(msg.entry);
      return {
        ...state,
        logs: [...state.logs.slice(-(MAX_CLIENT_LOGS - 1)), msg.entry],
        lastProcessed: applyLastProcessed(state.lastProcessed, msg.entry),
        activity: applyActivity(state.activity, msg.entry),
      };
    default:
      // *Result messages are handled by the pending-request map in send(), not the reducer.
      return state;
  }
}

interface Ctx {
  state: State;
  send: (msg: ClientToServer) => Promise<ServerToClient>;
}

const FlowbunSocketCtx = createContext<Ctx | null>(null);

export function useFlowbunSocket(): Ctx {
  const ctx = useContext(FlowbunSocketCtx);
  if (!ctx)
    throw new Error(
      "useFlowbunSocket must be used inside FlowbunSocketProvider",
    );
  return ctx;
}

export function FlowbunSocketProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, {
    connected: false,
    flows: new Map<string, FlowEntry>(),
    palette: [],
    logs: [],
    lastProcessed: new Map<string, number>(),
    activity: new Map<string, number>(),
  });
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (msg: ServerToClient) => void>());

  useEffect(() => {
    let cancelled = false;
    let retryDelay = 500;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      const { coordinatorWsUrl } = (await fetch("/config.json").then((r) =>
        r.json(),
      )) as {
        coordinatorWsUrl: string;
      };
      if (cancelled) return;
      const ws = new WebSocket(coordinatorWsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: "connected", value: true });
        retryDelay = 500;
      };
      ws.onclose = () => {
        dispatch({ type: "connected", value: false });
        if (!cancelled) {
          retryDelay = Math.min(retryDelay * 2, 10_000);
          timer = setTimeout(connect, retryDelay);
        }
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerToClient;
        if ("requestId" in msg) {
          pending.current.get(msg.requestId)?.(msg);
        } else {
          dispatch({ type: "server", msg });
        }
      };
    }
    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientToServer): Promise<ServerToClient> => {
    return new Promise((resolve) => {
      pending.current.set(msg.requestId, (m) => {
        pending.current.delete(msg.requestId);
        resolve(m);
      });
      wsRef.current?.send(JSON.stringify(msg));
    });
  }, []);

  return (
    <FlowbunSocketCtx.Provider value={{ state, send }}>
      {children}
    </FlowbunSocketCtx.Provider>
  );
}
