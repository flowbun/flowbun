import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ServerWebSocket } from "bun";
import type { BlockRegistry, Wiring } from "flowbun";
import type {
  BlockPaletteEntry,
  ClientToServer,
  DbQueryOutcome,
  FlowEntry,
  HassEntitySummary,
  ServerToClient,
  TypecheckOutcome,
} from "flowbun/ws";
import type { AgentRunner } from "./agent/runner";
import type { ChatEventBuffer } from "./chat-event-buffer";
import { formatWithBiome } from "./format-block";
import type { GitSnapshotter } from "./git-snapshot";
import type { LogBuffer } from "./log-buffer";
import type { Supervisor } from "./supervisor";
import type { CoordinatorStats } from "./system-stats";
import type { UndoStack } from "./undo-stack";
import {
  applyMutation,
  describeMutation,
  WiringWriteError,
} from "./wiring-writer";

export interface WsServerDeps {
  dataDir: string;
  /** Repo root (biome.json + node_modules live here) — used only to format
   * block source on save. */
  repoRoot: string;
  supervisor: Supervisor;
  logBuffer: LogBuffer;
  chatEvents: ChatEventBuffer;
  agentRunner: AgentRunner;
  /** Live view of every known wiring file — main.ts owns this Map and keeps
   * it current across reloads; both fs-watcher-triggered and ws-triggered
   * reloads write through it. */
  flows: Map<string, FlowEntry>;
  undoStack: UndoStack;
  /** Backs history.list/history.restore — see git-snapshot.ts. Every write
   * path itself auto-commits via the snapshotting serializer in main.ts;
   * this is only ever read from here, never written to directly. */
  gitSnapshotter: GitSnapshotter;
  getPalette: () => BlockPaletteEntry[];
  reloadWiringFile: (path: string, label?: string) => Promise<TypecheckOutcome>;
  reloadBlocksAndRestartAll: (label?: string) => Promise<TypecheckOutcome>;
  createFlow: (name: string) => Promise<{ file: string; wiring: Wiring }>;
  createBlock: (name: string) => Promise<{ file: string; source: string }>;
  deleteBlock: (file: string) => Promise<void>;
  deleteFlow: (file: string) => Promise<void>;
  listHassEntities: () => Promise<HassEntitySummary[]>;
  /** Records an absolute path just written via the ws API so the
   * fs-watcher's own independent trigger for that same write can be
   * suppressed instead of running a redundant second reload. */
  markSelfWrite: (path: string) => void;
  /** Everything except `websocket.connectedClients` — this module fills
   * that one field in itself, from the live `sockets` set below. */
  getSystemStats: () => Promise<CoordinatorStats>;
  /** Runs one arbitrary SQL statement against the coordinator's
   * long-lived REPL connection (see main.ts) — synchronous under the
   * hood (bun:sqlite), wrapped as async purely so a thrown syntax error
   * becomes a rejected promise, matching every other deps call here. */
  queryDb: (sql: string) => Promise<DbQueryOutcome>;
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

export function isSafeBlockFilename(file: string): boolean {
  return !file.includes("/") && !file.includes("..") && file.endsWith(".ts");
}

export function startWsServer(port: number, deps: WsServerDeps) {
  const sockets = new Set<ServerWebSocket<undefined>>();

  function broadcast(msg: ServerToClient): void {
    const s = JSON.stringify(msg);
    for (const ws of sockets) ws.send(s);
  }

  deps.logBuffer.subscribe((entry) => broadcast({ type: "log", entry }));
  deps.chatEvents.subscribe((event) =>
    broadcast({ type: "chat.event", event }),
  );

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
          chatEvents: [...deps.chatEvents.all()],
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
              const typecheck = await deps.reloadWiringFile(
                path,
                `${msg.file}: ${describeMutation(msg.mutation)}`,
              );
              await deps.undoStack.recordEdit(join("wiring", msg.file));
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
          case "wiring.undo":
          case "wiring.redo": {
            const resultType =
              msg.type === "wiring.undo"
                ? "wiring.undoResult"
                : "wiring.redoResult";
            try {
              const entry = deps.flows.get(msg.file);
              if (!entry)
                throw new WiringWriteError(`unknown wiring file "${msg.file}"`);
              const path = join(deps.dataDir, "wiring", msg.file);
              const relPath = join("wiring", msg.file);
              const restoredText =
                msg.type === "wiring.undo"
                  ? await deps.undoStack.undo(relPath)
                  : await deps.undoStack.redo(relPath);
              if (restoredText === undefined) {
                throw new WiringWriteError(
                  msg.type === "wiring.undo"
                    ? "nothing to undo"
                    : "nothing to redo",
                );
              }
              writeFileSync(path, restoredText);
              const typecheck = await deps.reloadWiringFile(
                path,
                `${msg.type}: ${msg.file}`,
              );
              const updated = deps.flows.get(msg.file);
              reply({
                type: resultType,
                requestId: msg.requestId,
                ok: true,
                wiring: updated ? updated.wiring : JSON.parse(restoredText),
                typecheck,
              });
            } catch (err) {
              reply({
                type: resultType,
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
              const path = join(deps.dataDir, "blocks", msg.file);
              const relPath = join("blocks", msg.file);
              const formatted = await formatWithBiome(
                msg.source,
                relative(deps.repoRoot, path),
                deps.repoRoot,
              );
              writeFileSync(path, formatted);
              deps.markSelfWrite(path);
              const typecheck = await deps.reloadBlocksAndRestartAll(
                `block write: ${msg.file}`,
              );
              await deps.undoStack.recordEdit(relPath);
              reply({
                type: "block.writeResult",
                requestId: msg.requestId,
                ok: true,
                typecheck,
                source: formatted,
                undo: deps.undoStack.status(relPath),
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
              const relPath = join("blocks", msg.file);
              const source = readFileSync(
                join(deps.dataDir, "blocks", msg.file),
                "utf8",
              );
              reply({
                type: "block.readResult",
                requestId: msg.requestId,
                ok: true,
                source,
                undo: deps.undoStack.status(relPath),
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
          case "block.undo":
          case "block.redo": {
            const resultType =
              msg.type === "block.undo"
                ? "block.undoResult"
                : "block.redoResult";
            try {
              if (!isSafeBlockFilename(msg.file))
                throw new Error(`invalid block filename "${msg.file}"`);
              const relPath = join("blocks", msg.file);
              const restoredText =
                msg.type === "block.undo"
                  ? await deps.undoStack.undo(relPath)
                  : await deps.undoStack.redo(relPath);
              if (restoredText === undefined) {
                throw new Error(
                  msg.type === "block.undo"
                    ? "nothing to undo"
                    : "nothing to redo",
                );
              }
              const path = join(deps.dataDir, "blocks", msg.file);
              writeFileSync(path, restoredText);
              deps.markSelfWrite(path);
              const typecheck = await deps.reloadBlocksAndRestartAll(
                `${msg.type}: ${msg.file}`,
              );
              reply({
                type: resultType,
                requestId: msg.requestId,
                ok: true,
                source: restoredText,
                typecheck,
                undo: deps.undoStack.status(relPath),
              });
            } catch (err) {
              reply({
                type: resultType,
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "block.delete": {
            try {
              if (!isSafeBlockFilename(msg.file))
                throw new Error(`invalid block filename "${msg.file}"`);
              await deps.deleteBlock(msg.file);
              reply({
                type: "block.deleteResult",
                requestId: msg.requestId,
                ok: true,
              });
            } catch (err) {
              reply({
                type: "block.deleteResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "flow.delete": {
            try {
              await deps.deleteFlow(msg.file);
              reply({
                type: "flow.deleteResult",
                requestId: msg.requestId,
                ok: true,
              });
            } catch (err) {
              reply({
                type: "flow.deleteResult",
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
          case "flow.create": {
            try {
              const { file, wiring } = await deps.createFlow(msg.name);
              reply({
                type: "flow.createResult",
                requestId: msg.requestId,
                ok: true,
                file,
                wiring,
              });
            } catch (err) {
              reply({
                type: "flow.createResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "block.create": {
            try {
              const { file, source } = await deps.createBlock(msg.name);
              reply({
                type: "block.createResult",
                requestId: msg.requestId,
                ok: true,
                file,
                source,
              });
            } catch (err) {
              reply({
                type: "block.createResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "hass.entities": {
            try {
              const entities = await deps.listHassEntities();
              reply({
                type: "hass.entitiesResult",
                requestId: msg.requestId,
                ok: true,
                entities,
              });
            } catch (err) {
              reply({
                type: "hass.entitiesResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "system.stats": {
            try {
              const stats = await deps.getSystemStats();
              reply({
                type: "system.statsResult",
                requestId: msg.requestId,
                ok: true,
                stats: {
                  ...stats,
                  websocket: { connectedClients: sockets.size },
                },
              });
            } catch (err) {
              reply({
                type: "system.statsResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "db.query": {
            try {
              const outcome = await deps.queryDb(msg.sql);
              reply({
                type: "db.queryResult",
                requestId: msg.requestId,
                ok: true,
                ...outcome,
              });
            } catch (err) {
              reply({
                type: "db.queryResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "history.list": {
            try {
              const relPath = join(
                msg.kind === "wiring" ? "wiring" : "blocks",
                msg.file,
              );
              const entries = await deps.gitSnapshotter.history(relPath, 50);
              reply({
                type: "history.listResult",
                requestId: msg.requestId,
                ok: true,
                entries,
              });
            } catch (err) {
              reply({
                type: "history.listResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "history.restore": {
            try {
              const subdir = msg.kind === "wiring" ? "wiring" : "blocks";
              // A wiring restore only rewrites an *active* flow's content —
              // resurrecting a fully-deleted flow would leave it stuck at
              // "starting" forever, since supervisor.restartFlow() is a
              // no-op for a flow it was never told to start (see
              // supervisor.ts). Recreating via "+ Flow" is the supported
              // path for a flow that's actually gone.
              if (msg.kind === "wiring" && !deps.flows.has(msg.file)) {
                throw new WiringWriteError(
                  `flow "${msg.file}" no longer exists — recreate it via "+ Flow" first`,
                );
              }
              const relPath = join(subdir, msg.file);
              const content = await deps.gitSnapshotter.readFileAt(
                msg.hash,
                relPath,
              );
              if (content === undefined) {
                throw new Error(
                  `"${msg.file}" had no content at ${msg.hash.slice(0, 7)}`,
                );
              }
              const path = join(deps.dataDir, subdir, msg.file);
              writeFileSync(path, content);
              deps.markSelfWrite(path);
              const label = `restore ${msg.file} to ${msg.hash.slice(0, 7)}`;
              const typecheck =
                msg.kind === "wiring"
                  ? await deps.reloadWiringFile(path, label)
                  : await deps.reloadBlocksAndRestartAll(label);
              await deps.undoStack.recordEdit(relPath);
              reply({
                type: "history.restoreResult",
                requestId: msg.requestId,
                ok: true,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "history.restoreResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "chat.send": {
            if (deps.agentRunner.isBusy()) {
              reply({
                type: "chat.sendResult",
                requestId: msg.requestId,
                ok: false,
                error: "agent is still responding to a previous message",
              });
              break;
            }
            reply({
              type: "chat.sendResult",
              requestId: msg.requestId,
              ok: true,
            });
            // Not awaited — the reply above already acknowledged the send;
            // the actual response streams back as "chat.event" broadcasts
            // (see agent/runner.ts). sendMessage() itself never rejects, so
            // this .catch() is defense in depth only.
            deps.agentRunner
              .sendMessage(msg.text, msg.requestId)
              .catch((err) => {
                deps.chatEvents.push({
                  kind: "turn.error",
                  turnId: msg.requestId,
                  reason: "other",
                  message: String(err),
                });
              });
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
