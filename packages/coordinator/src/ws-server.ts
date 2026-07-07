import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ServerWebSocket } from "bun";
import type { BlockRegistry } from "flowbun";
import type {
  BlockPaletteEntry,
  ClientToServer,
  FlowEntry,
  ServerToClient,
  TypecheckOutcome,
} from "flowbun/ws";
import type { LogBuffer } from "./log-buffer";
import type { Supervisor } from "./supervisor";
import { applyMutation, WiringWriteError } from "./wiring-writer";

export interface WsServerDeps {
  dataDir: string;
  supervisor: Supervisor;
  logBuffer: LogBuffer;
  /** Live view of every known wiring file — main.ts owns this Map and keeps
   * it current across reloads; both fs-watcher-triggered and ws-triggered
   * reloads write through it. */
  flows: Map<string, FlowEntry>;
  getPalette: () => BlockPaletteEntry[];
  reloadWiringFile: (path: string) => Promise<TypecheckOutcome>;
  reloadBlocksAndRestartAll: () => Promise<TypecheckOutcome>;
}

export function buildPalette(
  dataDir: string,
  registry: BlockRegistry,
): BlockPaletteEntry[] {
  return [...registry.entries()].map(([name, entry]) => ({
    name,
    file: entry.modulePath.startsWith("flowbun/")
      ? undefined
      : relative(join(dataDir, "blocks"), entry.modulePath),
    inputs: Object.fromEntries(
      Object.keys(entry.def.inputs).map((k) => [k, null]),
    ),
    outputs: Object.fromEntries(
      Object.keys(entry.def.outputs).map((k) => [k, null]),
    ),
    defaultConfig: entry.def.config,
  }));
}

function isSafeBlockFilename(file: string): boolean {
  return !file.includes("/") && !file.includes("..") && file.endsWith(".ts");
}

export function startWsServer(port: number, deps: WsServerDeps) {
  const sockets = new Set<ServerWebSocket<undefined>>();

  function broadcast(msg: ServerToClient): void {
    const s = JSON.stringify(msg);
    for (const ws of sockets) ws.send(s);
  }

  deps.logBuffer.subscribe((entry) => broadcast({ type: "log", entry }));

  const server = Bun.serve({
    port,
    routes: {
      "/ws": (req, srv) =>
        srv.upgrade(req)
          ? undefined
          : new Response("expected websocket", { status: 400 }),
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        sockets.add(ws);
        const snapshot: ServerToClient = {
          type: "snapshot",
          flows: [...deps.flows.values()],
          palette: deps.getPalette(),
          logs: deps.logBuffer.all().slice(-500),
        };
        ws.send(JSON.stringify(snapshot));
      },
      async message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
        const msg = JSON.parse(String(raw)) as ClientToServer;
        const reply = (m: ServerToClient) => ws.send(JSON.stringify(m));

        switch (msg.type) {
          case "wiring.mutate": {
            try {
              const entry = deps.flows.get(msg.file);
              if (!entry)
                throw new WiringWriteError(`unknown wiring file "${msg.file}"`);
              const path = join(deps.dataDir, "wiring", msg.file);
              const currentText = readFileSync(path, "utf8");
              const nextText = applyMutation(currentText, msg.mutation);
              writeFileSync(path, nextText);
              const typecheck = await deps.reloadWiringFile(path);
              const updated = deps.flows.get(msg.file);
              reply({
                type: "wiring.mutateResult",
                requestId: msg.requestId,
                ok: true,
                wiring: updated ? updated.wiring : JSON.parse(nextText),
                typecheck,
              });
            } catch (err) {
              reply({
                type: "wiring.mutateResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "block.write": {
            try {
              if (!isSafeBlockFilename(msg.file))
                throw new Error(`invalid block filename "${msg.file}"`);
              writeFileSync(join(deps.dataDir, "blocks", msg.file), msg.source);
              const typecheck = await deps.reloadBlocksAndRestartAll();
              reply({
                type: "block.writeResult",
                requestId: msg.requestId,
                ok: true,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "block.writeResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "block.read": {
            try {
              if (!isSafeBlockFilename(msg.file))
                throw new Error(`invalid block filename "${msg.file}"`);
              const source = readFileSync(
                join(deps.dataDir, "blocks", msg.file),
                "utf8",
              );
              reply({
                type: "block.readResult",
                requestId: msg.requestId,
                ok: true,
                source,
              });
            } catch (err) {
              reply({
                type: "block.readResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "flow.restart": {
            try {
              await deps.supervisor.restartFlow(msg.flow);
              reply({
                type: "flow.restartResult",
                requestId: msg.requestId,
                ok: true,
              });
            } catch (err) {
              reply({
                type: "flow.restartResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
        }
      },
      close(ws: ServerWebSocket<undefined>) {
        sockets.delete(ws);
      },
    },
  });

  return { server, broadcast };
}
