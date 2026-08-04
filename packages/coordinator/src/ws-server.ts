import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ServerWebSocket } from "bun";
import type { BlockRegistry, Wiring } from "flowbun";
import { isAuthorized } from "flowbun/auth";
import type {
  BlockPaletteEntry,
  ClientToServer,
  DbQueryOutcome,
  FlowEntry,
  HassEntitySummary,
  NpmPackageEntry,
  ServerToClient,
  TypecheckOutcome,
} from "flowbun/ws";
import type { AiHostClient } from "./ai-host-client";
import { extractBlockName } from "./block-source";
import type { ChatEventBuffer } from "./chat-event-buffer";
import type { FlowPackageManager } from "./flow-packages";
import { ModifiedFilesError } from "./flow-packages";
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
  aiHostClient: AiHostClient;
  /** Live view of every known wiring file — main.ts owns this Map and keeps
   * it current across reloads; both fs-watcher-triggered and ws-triggered
   * reloads write through it. */
  flows: Map<string, FlowEntry>;
  undoStack: UndoStack;
  /** Backs history.list/history.restore — see git-snapshot.ts. Every write
   * path itself auto-commits via the snapshotting serializer in main.ts;
   * this is only ever read from here, never written to directly. */
  gitSnapshotter: GitSnapshotter;
  /** Restores a wiring file AND every file-backed block it references,
   * together, from the same historical commit — see history.restore below.
   * Rolls back to the exact prior content of everything it touched if the
   * reconstructed set doesn't actually work. */
  restoreFlow: (
    file: string,
    hash: string,
  ) => Promise<
    { ok: true; typecheck: TypecheckOutcome } | { ok: false; error: string }
  >;
  getPalette: () => BlockPaletteEntry[];
  reloadWiringFile: (path: string, label?: string) => Promise<TypecheckOutcome>;
  reloadBlocksAndRestartAll: (label?: string) => Promise<TypecheckOutcome>;
  createFlow: (name: string) => Promise<{ file: string; wiring: Wiring }>;
  createBlock: (name: string) => Promise<{ file: string; source: string }>;
  duplicateBlock: (
    blockName: string,
  ) => Promise<{ file: string; name: string; source: string }>;
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
  /** data/'s own npm dependencies — see coordinator's npm-packages.ts. */
  listNpmPackages: () => Promise<NpmPackageEntry[]>;
  installNpmPackage: (
    spec: string,
  ) => Promise<{ output: string; typecheck: TypecheckOutcome }>;
  removeNpmPackage: (
    name: string,
  ) => Promise<{ output: string; typecheck: TypecheckOutcome }>;
  /** data/'s installed flowbun packages (blocks + example wiring) — see
   * coordinator's flow-packages.ts. */
  flowPackages: FlowPackageManager;
}

export function buildPalette(
  dataDir: string,
  registry: BlockRegistry,
): BlockPaletteEntry[] {
  return [...registry.entries()].map(([name, entry]) => ({
    name,
    file:
      entry.origin === "builtin"
        ? undefined
        : relative(join(dataDir, "blocks"), entry.modulePath),
    inputs: Object.fromEntries(
      Object.keys(entry.def.inputs).map((k) => [k, null]),
    ),
    outputs: Object.fromEntries(
      Object.keys(entry.def.outputs).map((k) => [k, null]),
    ),
    defaultConfig: entry.def.config,
    control: entry.def.control,
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
  deps.chatEvents.subscribeReset((events) =>
    broadcast({ type: "chat.historyReset", events: [...events] }),
  );

  const server = Bun.serve({
    port,
    routes: {
      // Opt-in: isAuthorized() is a no-op passthrough unless
      // FLOWBUN_AUTH_USERNAME/FLOWBUN_AUTH_PASSWORD are both set (see
      // flowbun/auth's own doc comment) — every existing unauthenticated
      // deployment keeps working exactly as before. When auth *is*
      // configured, this is the actual enforcement point: the editor's own
      // login screen is just UX around getting a valid session token, not a
      // security boundary in itself, since nothing stops a client from
      // talking to this port directly (by design — see README's "no
      // privileged access" principle for the editor).
      "/ws": (req, srv) => {
        if (!isAuthorized(req, deps.dataDir)) {
          return new Response("unauthorized", { status: 401 });
        }
        return srv.upgrade(req)
          ? undefined
          : new Response("expected websocket", { status: 400 });
      },
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
              // Mark this write as our own *before* the (potentially
              // queue-delayed — see main.ts's serializeReload comment)
              // reload below, not after: fs.watch can otherwise fire first
              // and, finding no recentSelfWrites entry yet, misattribute
              // this write to an external edit — a redundant second reload
              // plus a spurious duplicate undo-stack entry for one logical
              // change. Matches block.write's own already-correct ordering.
              deps.markSelfWrite(path);
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
              // Same reasoning as wiring.mutate above: mark it before the
              // reload, not after.
              deps.markSelfWrite(path);
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
                name: extractBlockName(formatted),
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
                name: extractBlockName(source),
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
                name: extractBlockName(restoredText),
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
          case "block.duplicate": {
            try {
              const result = await deps.duplicateBlock(msg.blockName);
              reply({
                type: "block.duplicateResult",
                requestId: msg.requestId,
                ok: true,
                file: result.file,
                name: result.name,
                source: result.source,
              });
            } catch (err) {
              reply({
                type: "block.duplicateResult",
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
          case "flow.fireNode": {
            try {
              const result = await deps.supervisor.fireNode(
                msg.flow,
                msg.nodeId,
              );
              reply(
                result.ok
                  ? {
                      type: "flow.fireNodeResult",
                      requestId: msg.requestId,
                      ok: true,
                    }
                  : {
                      type: "flow.fireNodeResult",
                      requestId: msg.requestId,
                      ok: false,
                      error: result.error ?? "unknown error",
                    },
              );
            } catch (err) {
              reply({
                type: "flow.fireNodeResult",
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
          case "pkg.npm.list": {
            try {
              const packages = await deps.listNpmPackages();
              reply({
                type: "pkg.npm.listResult",
                requestId: msg.requestId,
                ok: true,
                packages,
              });
            } catch (err) {
              reply({
                type: "pkg.npm.listResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.npm.add": {
            try {
              const { output, typecheck } = await deps.installNpmPackage(
                msg.spec,
              );
              reply({
                type: "pkg.npm.addResult",
                requestId: msg.requestId,
                ok: true,
                output,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "pkg.npm.addResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.npm.remove": {
            try {
              const { output, typecheck } = await deps.removeNpmPackage(
                msg.name,
              );
              reply({
                type: "pkg.npm.removeResult",
                requestId: msg.requestId,
                ok: true,
                output,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "pkg.npm.removeResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.flow.registry": {
            try {
              const { source, packages } =
                await deps.flowPackages.browseRegistry();
              reply({
                type: "pkg.flow.registryResult",
                requestId: msg.requestId,
                ok: true,
                source,
                packages,
              });
            } catch (err) {
              reply({
                type: "pkg.flow.registryResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.flow.list": {
            try {
              const packages = await deps.flowPackages.listInstalled();
              reply({
                type: "pkg.flow.listResult",
                requestId: msg.requestId,
                ok: true,
                packages,
              });
            } catch (err) {
              reply({
                type: "pkg.flow.listResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.flow.install": {
            try {
              const { version, output, typecheck } =
                await deps.flowPackages.install(msg.name, msg.version);
              reply({
                type: "pkg.flow.installResult",
                requestId: msg.requestId,
                ok: true,
                version,
                output,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "pkg.flow.installResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.flow.uninstall": {
            try {
              const { output, modifiedFiles } =
                await deps.flowPackages.uninstall(msg.name);
              reply({
                type: "pkg.flow.uninstallResult",
                requestId: msg.requestId,
                ok: true,
                output,
                modifiedFiles,
              });
            } catch (err) {
              reply({
                type: "pkg.flow.uninstallResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
              });
            }
            break;
          }
          case "pkg.flow.update": {
            try {
              const { version, output, typecheck } =
                await deps.flowPackages.update(msg.name, {
                  version: msg.version,
                  force: msg.force,
                });
              reply({
                type: "pkg.flow.updateResult",
                requestId: msg.requestId,
                ok: true,
                version,
                output,
                typecheck,
              });
            } catch (err) {
              reply({
                type: "pkg.flow.updateResult",
                requestId: msg.requestId,
                ok: false,
                error: String(err),
                ...(err instanceof ModifiedFilesError
                  ? { modifiedFiles: err.files }
                  : {}),
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
            if (msg.kind === "wiring") {
              // A wiring restore only rewrites an *active* flow's content —
              // resurrecting a fully-deleted flow would leave it stuck at
              // "starting" forever, since supervisor.restartFlow() is a
              // no-op for a flow it was never told to start (see
              // supervisor.ts). Recreating via "+ Flow" is the supported
              // path for a flow that's actually gone.
              if (!deps.flows.has(msg.file)) {
                reply({
                  type: "history.restoreResult",
                  requestId: msg.requestId,
                  ok: false,
                  error: `flow "${msg.file}" no longer exists — recreate it via "+ Flow" first`,
                });
                break;
              }
              // Restores the wiring together with every file-backed block
              // it references, from the same commit, rolling back
              // everything it touched if the reconstructed set doesn't
              // actually work — see restoreFlow's own doc comment in
              // main.ts for why a wiring-only restore isn't safe.
              //
              // Wrapped defensively even though restoreFlow is designed to
              // always resolve rather than throw: an uncaught exception
              // anywhere in this call chain has twice now escaped all the
              // way up and crashed the entire coordinator process (killing
              // every other flow along with it), so this boundary — the
              // one place nothing after it could catch it — doesn't get to
              // assume that can't happen a third time.
              try {
                const result = await deps.restoreFlow(msg.file, msg.hash);
                reply(
                  result.ok
                    ? {
                        type: "history.restoreResult",
                        requestId: msg.requestId,
                        ok: true,
                        typecheck: result.typecheck,
                      }
                    : {
                        type: "history.restoreResult",
                        requestId: msg.requestId,
                        ok: false,
                        error: result.error,
                      },
                );
              } catch (err) {
                reply({
                  type: "history.restoreResult",
                  requestId: msg.requestId,
                  ok: false,
                  error: `unexpected error restoring "${msg.file}": ${err}`,
                });
              }
              break;
            }
            // Blocks kind: restores just the one source file's history —
            // a narrower, single-file feature (e.g. from the block
            // editor's own history panel), distinct from restoreFlow()
            // above. A block on its own has no "wiring" to go out of sync
            // with; reloadBlocksAndRestartAll() already refuses to restart
            // any flow this would break (see its own doc comment) rather
            // than leaving something broken running.
            try {
              const relPath = join("blocks", msg.file);
              const content = await deps.gitSnapshotter.readFileAt(
                msg.hash,
                relPath,
              );
              if (content === undefined) {
                throw new Error(
                  `"${msg.file}" had no content at ${msg.hash.slice(0, 7)}`,
                );
              }
              const path = join(deps.dataDir, "blocks", msg.file);
              writeFileSync(path, content);
              deps.markSelfWrite(path);
              const label = `restore ${msg.file} to ${msg.hash.slice(0, 7)}`;
              const typecheck = await deps.reloadBlocksAndRestartAll(label);
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
            if (deps.aiHostClient.isBusy()) {
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
            // Fire-and-forget — the reply above already acknowledged the
            // send; the actual response streams back as "chat.event"
            // broadcasts (relayed from ai-host by ai-host-client.ts).
            deps.aiHostClient.sendChat(
              msg.text,
              msg.requestId,
              msg.currentFlow,
            );
            break;
          }
          case "chat.newSession": {
            const r = await deps.aiHostClient.newChatSession();
            if (r.ok) deps.chatEvents.replace([]);
            reply(
              r.ok
                ? {
                    type: "chat.newSessionResult",
                    requestId: msg.requestId,
                    ok: true,
                  }
                : {
                    type: "chat.newSessionResult",
                    requestId: msg.requestId,
                    ok: false,
                    error: r.error ?? "unknown error",
                  },
            );
            break;
          }
          case "chat.listSessions": {
            const r = await deps.aiHostClient.listChatSessions();
            reply(
              r.ok
                ? {
                    type: "chat.sessionsResult",
                    requestId: msg.requestId,
                    ok: true,
                    sessions: r.sessions,
                  }
                : {
                    type: "chat.sessionsResult",
                    requestId: msg.requestId,
                    ok: false,
                    error: r.error,
                  },
            );
            break;
          }
          case "chat.resumeSession": {
            const r = await deps.aiHostClient.resumeChatSession(msg.sessionId);
            if (r.ok && r.events) deps.chatEvents.replace(r.events);
            reply(
              r.ok
                ? {
                    type: "chat.resumeSessionResult",
                    requestId: msg.requestId,
                    ok: true,
                    sessionId: msg.sessionId,
                  }
                : {
                    type: "chat.resumeSessionResult",
                    requestId: msg.requestId,
                    ok: false,
                    error: r.error ?? "unknown error",
                  },
            );
            break;
          }
          case "ping": {
            reply({ type: "pong", requestId: msg.requestId });
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
