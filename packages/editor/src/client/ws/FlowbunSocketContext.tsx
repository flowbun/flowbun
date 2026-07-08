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
}

type Action =
  | { type: "server"; msg: ServerToClient }
  | { type: "connected"; value: boolean };

const MAX_CLIENT_LOGS = 2000;

function reducer(state: State, action: Action): State {
  if (action.type === "connected") return { ...state, connected: action.value };
  const msg = action.msg;
  switch (msg.type) {
    case "snapshot":
      return {
        ...state,
        flows: new Map(msg.flows.map((f) => [f.file, f])),
        palette: msg.palette,
        logs: msg.logs,
      };
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
    case "palette.updated":
      return { ...state, palette: msg.palette };
    case "log":
      // Stage 2's hard requirement: unconditional, independent of whether
      // the LogPanel is even mounted.
      logToDevtoolsConsole(msg.entry);
      return {
        ...state,
        logs: [...state.logs.slice(-(MAX_CLIENT_LOGS - 1)), msg.entry],
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
