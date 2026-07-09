import type { LogRecord } from "../ipc/protocol";
import type { Wiring } from "../wiring/schema";

/**
 * Moved here (not left in coordinator/src/supervisor.ts) because it needs
 * to cross the coordinator -> browser boundary, and `flowbun` is the only
 * package both sides already depend on — the browser bundle can't import
 * from `coordinator`, and `coordinator` shouldn't depend on `editor`.
 */
export type FlowStatus =
  | { kind: "starting" }
  | { kind: "running"; pid: number; since: number }
  | { kind: "degraded"; pid: number; since: number; reason: string }
  | { kind: "restarting"; attempt: number; nextAttemptAt: number }
  | {
      kind: "failed-typecheck";
      at: number;
      output: string;
      stillRunning: boolean;
      pid?: number;
    }
  | { kind: "crash-looped"; at: number; attempts: number };

export interface WiringPosition {
  x: number;
  y: number;
}

export interface UndoStatus {
  canUndo: boolean;
  canRedo: boolean;
}

export interface FlowEntry {
  /** Filename under data/wiring/, e.g. "hallway_lights.json" — the handle
   * every wiring-scoped command uses. Not an absolute path: the client has
   * no business knowing the coordinator's filesystem layout, and this also
   * doubles as the whitelist the server checks writes against. */
  file: string;
  wiring: Wiring;
  status: FlowStatus;
  /** Server-held, per-file history of user-initiated wiring.mutate calls
   * only (never externally-detected file edits) — see coordinator's
   * undo-stack.ts. */
  undo: UndoStatus;
}

export interface BlockPaletteEntry {
  name: string;
  /** Filename under data/blocks/, absent for the two built-in @hass/* blocks (not user-editable). */
  file?: string;
  /** Port *names* only — BlockDef's inputs/outputs are phantom-typed (see
   * block.ts), so at runtime `Object.keys(def.inputs)` is all that's
   * introspectable. Each value is `null`, an explicit "shape unknown" marker. */
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  /** The block's real default config value — the starting point for a freshly-dropped node's config-edit form. */
  defaultConfig: unknown;
}

export interface HassEntitySummary {
  id: string;
  friendlyName?: string;
}

/** One commit touching a file under data/ — see coordinator's
 * git-snapshot.ts (this is the wire-format mirror of its HistoryEntry,
 * same duplication pattern as HassEntitySummary above). */
export interface HistoryEntry {
  hash: string;
  date: string;
  message: string;
}

/** Snapshot of coordinator/system telemetry — gathered fresh on each
 * "system.stats" request (see coordinator/src/main.ts's collectSystemStats),
 * not pushed/streamed, since this is a "check in on it" view (the About
 * modal), not a live dashboard. */
export interface SystemStats {
  coordinator: {
    pid: number;
    uptimeSec: number;
    memory: {
      /** Resident set size — total memory actually held by the process. */
      rss: number;
      heapUsed: number;
      heapTotal: number;
    };
    bunVersion: string;
  };
  /** Count of OS-level processes whose executable is literally "bun" —
   * the coordinator itself plus one per running flow-host (each flow-host
   * is its own `bun run` subprocess; see supervisor.ts). Best-effort: 0 if
   * /proc isn't available (non-Linux), rather than failing the whole
   * request over one optional number. */
  bunProcessCount: number;
  flows: {
    total: number;
    /** FlowStatus["kind"] -> count, e.g. {running: 3, "failed-typecheck": 1}. */
    byStatus: Record<string, number>;
  };
  system: {
    totalMemBytes: number;
    freeMemBytes: number;
    /** 1/5/15-minute load averages — always [0,0,0] on platforms without
     * the concept (Windows), per Node's own os.loadavg() behavior. */
    loadAvg: [number, number, number];
    cpuCount: number;
    uptimeSec: number;
  };
  websocket: {
    connectedClients: number;
  };
  logBuffer: {
    size: number;
  };
  palette: {
    blockCount: number;
  };
}

/**
 * One step of a streamed agent reply — see coordinator's agent/events.ts,
 * which translates the Claude Agent SDK's own message stream into this
 * small, purpose-built set (not a passthrough of the SDK's ~35-member
 * message union, which the browser has no business knowing about).
 * `turnId` is the originating "chat.send" request's requestId, repurposed
 * as a grouping key (not a resolve-key, since these arrive as broadcasts,
 * not a response) so the client can fold a whole streamed reply into one
 * growing message-turn.
 */
export type ChatEvent =
  | { kind: "turn.started"; turnId: string; at: number }
  | { kind: "assistant.text"; turnId: string; text: string }
  | {
      kind: "tool.started";
      turnId: string;
      toolCallId: string;
      summary: string;
    }
  | {
      kind: "tool.finished";
      turnId: string;
      toolCallId: string;
      ok: boolean;
      summary?: string;
      error?: string;
    }
  | {
      kind: "turn.done";
      turnId: string;
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
    }
  | {
      kind: "turn.error";
      turnId: string;
      reason: "not_authenticated" | "max_turns" | "other";
      message: string;
    };

/** Result of running one arbitrary SQL statement typed into the log
 * panel's "DB" tab (see coordinator/src/db-repl.ts). `columns`/`rows` are
 * empty for a statement that doesn't produce a result set (CREATE/INSERT/
 * UPDATE/DELETE without RETURNING) — `changes`/`lastInsertRowid` are only
 * meaningful in that case. `rows` are arrays aligned to `columns`, not
 * objects, since column order (not just names) matters for rendering a
 * table. lastInsertRowid is a string — sqlite rowids can exceed
 * Number.MAX_SAFE_INTEGER, and stringifying up front avoids a bigint ever
 * reaching JSON.stringify (which throws on bigint). */
export interface DbQueryOutcome {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  changes?: number;
  lastInsertRowid?: string;
}

export type WiringMutation =
  | {
      op: "node.add";
      nodeId: string;
      block: string;
      config?: unknown;
      position: WiringPosition;
    }
  | { op: "node.remove"; nodeId: string }
  | { op: "node.config"; nodeId: string; config: unknown }
  | { op: "node.position"; nodeId: string; position: WiringPosition }
  | { op: "node.disabled"; nodeId: string; disabled: boolean }
  | { op: "wire.add"; from: string; to: string } // "nodeId.port" refs, per parsePortRef
  | { op: "wire.remove"; from: string; to: string }
  // Retargets one end (or both) of an existing wire to a different port on
  // the same node — e.g. reassigning which output a wire actually reads
  // from, via the canvas's wire-label picker. newFrom/newTo must repeat the
  // unchanged side verbatim when only one end is being reassigned.
  | {
      op: "wire.rewire";
      from: string;
      to: string;
      newFrom: string;
      newTo: string;
    };

export interface TypecheckOutcome {
  ok: boolean;
  output: string;
}

// ---------- browser -> coordinator ----------
export type ClientToServer =
  | {
      type: "wiring.mutate";
      requestId: string;
      file: string;
      mutation: WiringMutation;
    }
  | { type: "block.write"; requestId: string; file: string; source: string }
  | { type: "block.read"; requestId: string; file: string }
  | { type: "block.delete"; requestId: string; file: string }
  | { type: "flow.delete"; requestId: string; file: string }
  | { type: "flow.restart"; requestId: string; flow: string }
  | { type: "flow.fireNode"; requestId: string; flow: string; nodeId: string }
  | { type: "wiring.undo"; requestId: string; file: string }
  | { type: "wiring.redo"; requestId: string; file: string }
  | { type: "block.undo"; requestId: string; file: string }
  | { type: "block.redo"; requestId: string; file: string }
  | { type: "flow.create"; requestId: string; name: string }
  | { type: "block.create"; requestId: string; name: string }
  | { type: "hass.entities"; requestId: string }
  | { type: "system.stats"; requestId: string }
  | { type: "db.query"; requestId: string; sql: string }
  | {
      type: "history.list";
      requestId: string;
      kind: "wiring" | "block";
      file: string;
    }
  | {
      type: "history.restore";
      requestId: string;
      kind: "wiring" | "block";
      file: string;
      hash: string;
    }
  | { type: "chat.send"; requestId: string; text: string };

// ---------- coordinator -> browser ----------
export type ServerToClient =
  | {
      type: "snapshot";
      flows: FlowEntry[];
      palette: BlockPaletteEntry[];
      logs: LogRecord[];
      chatEvents: ChatEvent[];
    }
  | { type: "flow.updated"; file: string; wiring: Wiring; undo: UndoStatus }
  | { type: "flow.status"; flow: string; status: FlowStatus }
  /** Its wiring file was deleted from disk (detected by the fs-watcher) —
   * the flow-host has already been stopped; the client should drop the tab. */
  | { type: "flow.removed"; file: string }
  | { type: "palette.updated"; palette: BlockPaletteEntry[] }
  | { type: "log"; entry: LogRecord }
  | {
      type: "wiring.mutateResult";
      requestId: string;
      ok: true;
      wiring: Wiring;
      typecheck: TypecheckOutcome;
    }
  | { type: "wiring.mutateResult"; requestId: string; ok: false; error: string }
  | {
      type: "wiring.undoResult";
      requestId: string;
      ok: true;
      wiring: Wiring;
      typecheck: TypecheckOutcome;
    }
  | { type: "wiring.undoResult"; requestId: string; ok: false; error: string }
  | {
      type: "wiring.redoResult";
      requestId: string;
      ok: true;
      wiring: Wiring;
      typecheck: TypecheckOutcome;
    }
  | { type: "wiring.redoResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.writeResult";
      requestId: string;
      ok: true;
      typecheck: TypecheckOutcome;
      /** The text actually written to disk — may differ from what the
       * client sent if it was reformatted by Biome on save. */
      source: string;
      /** Blocks have no snapshot/broadcast channel the way wiring files do
       * (see FlowEntry.undo) — the Monaco editor's undo/redo buttons read
       * this directly off every block.*Result instead. */
      undo: UndoStatus;
    }
  | { type: "block.writeResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.readResult";
      requestId: string;
      ok: true;
      source: string;
      undo: UndoStatus;
    }
  | { type: "block.readResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.undoResult";
      requestId: string;
      ok: true;
      source: string;
      typecheck: TypecheckOutcome;
      undo: UndoStatus;
    }
  | { type: "block.undoResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.redoResult";
      requestId: string;
      ok: true;
      source: string;
      typecheck: TypecheckOutcome;
      undo: UndoStatus;
    }
  | { type: "block.redoResult"; requestId: string; ok: false; error: string }
  | { type: "block.deleteResult"; requestId: string; ok: true }
  | { type: "block.deleteResult"; requestId: string; ok: false; error: string }
  | { type: "flow.deleteResult"; requestId: string; ok: true }
  | { type: "flow.deleteResult"; requestId: string; ok: false; error: string }
  | { type: "flow.restartResult"; requestId: string; ok: true }
  | { type: "flow.restartResult"; requestId: string; ok: false; error: string }
  | { type: "flow.fireNodeResult"; requestId: string; ok: true }
  | { type: "flow.fireNodeResult"; requestId: string; ok: false; error: string }
  | {
      type: "flow.createResult";
      requestId: string;
      ok: true;
      /** Filename actually used — the server slugifies/validates the
       * requested name, so the client navigates to this rather than
       * guessing. */
      file: string;
      wiring: Wiring;
    }
  | { type: "flow.createResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.createResult";
      requestId: string;
      ok: true;
      /** Filename actually used (server slugifies/validates the name). */
      file: string;
      source: string;
    }
  | { type: "block.createResult"; requestId: string; ok: false; error: string }
  | {
      type: "hass.entitiesResult";
      requestId: string;
      ok: true;
      entities: HassEntitySummary[];
    }
  | {
      type: "hass.entitiesResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "system.statsResult";
      requestId: string;
      ok: true;
      stats: SystemStats;
    }
  | { type: "system.statsResult"; requestId: string; ok: false; error: string }
  | ({ type: "db.queryResult"; requestId: string; ok: true } & DbQueryOutcome)
  | { type: "db.queryResult"; requestId: string; ok: false; error: string }
  | {
      type: "history.listResult";
      requestId: string;
      ok: true;
      entries: HistoryEntry[];
    }
  | { type: "history.listResult"; requestId: string; ok: false; error: string }
  | {
      type: "history.restoreResult";
      requestId: string;
      ok: true;
      typecheck: TypecheckOutcome;
    }
  | {
      type: "history.restoreResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | { type: "chat.sendResult"; requestId: string; ok: true }
  | { type: "chat.sendResult"; requestId: string; ok: false; error: string }
  | { type: "chat.event"; event: ChatEvent };
