import type { BlockControl, BlockSummary } from "../block";
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
  // Distinct from failed-typecheck: assembleFlow() rejected the wiring
  // outright (unknown node, unknown port, ...) before tsc ever ran -- e.g. a
  // wire referencing a port a block no longer exposes. Never started, so
  // there's no "stillRunning" concept for it.
  | { kind: "failed-load"; at: number; output: string }
  | { kind: "crash-looped"; at: number; attempts: number }
  // The flow's own wiring has `disabled: true` — never spawned a
  // flow-host subprocess (or had its existing one stopped) on purpose, not
  // as the result of any failure. See main.ts's applyRunState.
  | { kind: "disabled" };

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
  /** Declarative on-canvas control (see block.ts's BlockControl) — lets
   * BlockNode.tsx render e.g. a fire button or a toggle switch directly on
   * the node, without hardcoding by block name. Absent for the common case
   * of a block with no canvas-level control at all. */
  control?: BlockControl;
  /** Declarative on-canvas config summary (see block.ts's BlockSummary) —
   * a *template*, not rendered text, precisely because this palette is
   * broadcast per block type while the config it describes is per node: the
   * client resolves it against each node's own config. Absent for a block
   * whose config has nothing worth surfacing on the canvas. */
  summary?: BlockSummary;
}

export interface HassEntitySummary {
  id: string;
  friendlyName?: string;
}

/** One dependency listed in data/package.json, cross-referenced against
 * what's actually on disk under data/node_modules — see coordinator's
 * npm-packages.ts. resolvedVersion is absent if the package is declared but
 * somehow not installed (e.g. node_modules was wiped and the self-heal
 * install hasn't run yet). */
export interface NpmPackageEntry {
  name: string;
  requestedRange: string;
  resolvedVersion?: string;
}

/** One file a flow package installed into data/ — path is registry-relative
 * ("blocks/foo.ts", "blocks/__tests__/foo.test.ts", "wiring/foo_demo.json").
 * sha256 is the hash of the bytes actually WRITTEN, not the registry's own
 * hash — wiring is re-serialized with `disabled: true` forced at install
 * time (see coordinator's flow-packages.ts), so recording the registry's
 * hash would make every wiring file read as "locally modified" the moment
 * it's installed. */
export interface InstalledFlowPackageFile {
  path: string;
  sha256: string;
}

/** One entry in data/flowbun-packages.json — see coordinator's
 * flow-packages.ts. */
export interface InstalledFlowPackage {
  name: string;
  version: string;
  /** The registry base (URL or local path) this was installed from. */
  source: string;
  installedAt: string; // ISO 8601
  npmDependencies: Record<string, string>;
  files: InstalledFlowPackageFile[];
}

/** One version of one registry package, as browsable from the editor —
 * mirrors index.json's shape plus a server-computed compatibility flag. */
export interface FlowPackageVersionInfo {
  version: string;
  description: string;
  author?: string;
  /** Raw compat range from the manifest, e.g. ">=0". */
  flowbun: string;
  /** False both when the range genuinely excludes this runtime's version
   * AND when the range couldn't be parsed at all — either way, install
   * refuses it. */
  compatible: boolean;
  npmDependencies: Record<string, string>;
  blocks: string[];
  wiring: string[];
  tests: string[];
}

export interface FlowPackageSummary {
  name: string;
  /** From data/flowbun-packages.json — absent if not installed. */
  installedVersion?: string;
  /** Newest first, mirroring index.json's own ordering. */
  versions: FlowPackageVersionInfo[];
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
  /** Only ever emitted during session-history replay (see coordinator's
   * agent/transcript.ts) — a live turn's user text is deliberately never
   * echoed back this way (the browser already renders its own optimistic
   * bubble from what it just sent), but a resumed session has no other
   * source for what the user originally asked. */
  | { kind: "user.text"; turnId: string; text: string }
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

/** One entry in the session picker (see coordinator's agent/session-store.ts
 * `listSessions`) — sourced from the Claude Agent SDK's own on-disk
 * transcripts, not anything flowbun persists itself. */
export interface ChatSessionSummary {
  id: string;
  /** First captured user prompt, truncated — falls back to `id` for a
   * session whose transcript has no readable user text yet. */
  title: string;
  startedAt: number;
  lastUsedAt: number;
}

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
  // Whole-flow equivalent of node.disabled — see WiringSchema.disabled's own
  // doc comment for why this one actually stops/starts a subprocess rather
  // than just being a router-level no-op.
  | { op: "flow.disabled"; disabled: boolean }
  // Renames a node's id (the wires/canvas display name) -- every wire
  // endpoint referencing it is rewritten in the same mutation, so the flow
  // never passes through a state where a wire points at a node id that no
  // longer exists.
  | { op: "node.rename"; nodeId: string; newNodeId: string }
  // Repoints an existing node at a different block, keeping everything else
  // about that node intact: its wires, position, config and `disabled` flag
  // all survive, because the node itself isn't being replaced — only which
  // block it runs. That's what makes the editor's "fork this built-in block
  // for just this node" action a single mutation (duplicate the block into
  // data/blocks/, then point this one node at the copy) rather than a
  // remove + re-add that would drop every wire and force a re-layout.
  | { op: "node.block"; nodeId: string; block: string }
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
  // Copies any palette block (built-in or add-on, keyed by its internal
  // `name`, since a built-in has no `file`) into a new, independently
  // editable file under data/blocks/ — see coordinator's duplicateBlock.
  | { type: "block.duplicate"; requestId: string; blockName: string }
  // Duplicates `blockName` into data/blocks/ AND repoints one existing node
  // at the copy, as a single server-side step. Two things make this a
  // dedicated message rather than a block.duplicate followed by a
  // node.block wiring.mutate from the client: the copy has to be confirmed
  // to have actually *registered* before anything points at it (a block
  // file that fails to import is skipped silently by discoverBlocks, so an
  // unchecked repoint would break the flow), and a client-driven pair can
  // half-succeed — leaving either an orphan block file or a node pointing
  // at nothing — with no single place to roll back from.
  | {
      type: "block.fork";
      requestId: string;
      /** Palette block to fork, by internal `name` (a built-in has no file). */
      blockName: string;
      /** Wiring file holding the node to repoint — NOT the block's file. */
      wiringFile: string;
      nodeId: string;
    }
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
  | { type: "pkg.npm.list"; requestId: string }
  | { type: "pkg.npm.add"; requestId: string; spec: string }
  | { type: "pkg.npm.remove"; requestId: string; name: string }
  | { type: "pkg.flow.registry"; requestId: string }
  | { type: "pkg.flow.list"; requestId: string }
  | {
      type: "pkg.flow.install";
      requestId: string;
      name: string;
      version?: string;
    }
  | { type: "pkg.flow.uninstall"; requestId: string; name: string }
  | {
      type: "pkg.flow.update";
      requestId: string;
      name: string;
      version?: string;
      force?: boolean;
    }
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
  | {
      type: "chat.send";
      requestId: string;
      text: string;
      /** The wiring file the sending tab currently has open in the canvas,
       * if any — lets the agent resolve an ambiguous "this flow"/"it"
       * without asking (see coordinator's system-prompt.ts,
       * buildSystemPromptAppend). Not persisted; just this one turn's
       * context. */
      currentFlow?: string;
    }
  | { type: "chat.newSession"; requestId: string }
  | { type: "chat.listSessions"; requestId: string }
  | { type: "chat.resumeSession"; requestId: string; sessionId: string }
  // App-level heartbeat (see FlowbunSocketContext) — a protocol-level pong
  // only proves the OS/browser TCP stack answered, not that this specific
  // tab's connection survived something like a sleep/wake; round-tripping
  // through the same request/reply path as everything else catches that.
  | { type: "ping"; requestId: string };

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
      /** The block's own `name:` field as read back out of `source` —
       * absent if it couldn't be found (e.g. a mid-edit save with no
       * defineBlock call yet). Lets the block editor's name field reflect
       * whatever's actually on disk, including a rename the client folded
       * into `source` before sending. */
      name?: string;
      /** Blocks have no snapshot/broadcast channel the way wiring files do
       * (see FlowEntry.undo) — the Monaco editor's undo/redo buttons read
       * this directly off every block.*Result instead. */
      undo: UndoStatus;
      /** Nodes repointed because this save renamed the block's own `name:`
       * field. Empty for an ordinary save. Renaming a block used to strand
       * every node referencing it (assembleFlow: "references unknown block"),
       * so the server now cascades the rename across every flow — this
       * reports what it touched, since silently rewriting other flows' files
       * would be worse than the bug it fixes. */
      repointed: Array<{ file: string; nodeIds: string[] }>;
    }
  | { type: "block.writeResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.readResult";
      requestId: string;
      ok: true;
      source: string;
      name?: string;
      undo: UndoStatus;
    }
  | { type: "block.readResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.undoResult";
      requestId: string;
      ok: true;
      source: string;
      name?: string;
      typecheck: TypecheckOutcome;
      undo: UndoStatus;
    }
  | { type: "block.undoResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.redoResult";
      requestId: string;
      ok: true;
      source: string;
      name?: string;
      typecheck: TypecheckOutcome;
      undo: UndoStatus;
    }
  | { type: "block.redoResult"; requestId: string; ok: false; error: string }
  | { type: "block.deleteResult"; requestId: string; ok: true }
  | { type: "block.deleteResult"; requestId: string; ok: false; error: string }
  | {
      type: "block.duplicateResult";
      requestId: string;
      ok: true;
      /** Filename actually used under data/blocks/ (server slugifies the
       * generated name). */
      file: string;
      /** The generated, still-generic name ("@core/scheduler 2") — the
       * caller opens the block editor on `file` so the user can rename it
       * from there. */
      name: string;
      source: string;
    }
  | {
      type: "block.duplicateResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "block.forkResult";
      requestId: string;
      ok: true;
      /** Filename actually used under data/blocks/ — the caller opens the
       * block editor on this. */
      file: string;
      /** The forked block's new internal name, derived from the node id it
       * was forked for (so the canvas reads "weekly_scheduler", not
       * "@core/scheduler 2") — suffixed if that name was already taken. */
      name: string;
      source: string;
      /** Post-repoint wiring, so the canvas updates in the same round trip
       * as every other wiring.mutate-shaped reply. */
      wiring: Wiring;
      typecheck: TypecheckOutcome;
    }
  | { type: "block.forkResult"; requestId: string; ok: false; error: string }
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
  | {
      type: "pkg.npm.listResult";
      requestId: string;
      ok: true;
      packages: NpmPackageEntry[];
    }
  | { type: "pkg.npm.listResult"; requestId: string; ok: false; error: string }
  | {
      type: "pkg.npm.addResult";
      requestId: string;
      ok: true;
      /** Combined stdout+stderr from `bun add`, shown to the user verbatim. */
      output: string;
      typecheck: TypecheckOutcome;
    }
  | { type: "pkg.npm.addResult"; requestId: string; ok: false; error: string }
  | {
      type: "pkg.npm.removeResult";
      requestId: string;
      ok: true;
      output: string;
      typecheck: TypecheckOutcome;
    }
  | {
      type: "pkg.npm.removeResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "pkg.flow.registryResult";
      requestId: string;
      ok: true;
      source: string;
      packages: FlowPackageSummary[];
    }
  | {
      type: "pkg.flow.registryResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "pkg.flow.listResult";
      requestId: string;
      ok: true;
      packages: InstalledFlowPackage[];
    }
  | { type: "pkg.flow.listResult"; requestId: string; ok: false; error: string }
  | {
      type: "pkg.flow.installResult";
      requestId: string;
      ok: true;
      version: string;
      output: string;
      typecheck: TypecheckOutcome;
    }
  | {
      type: "pkg.flow.installResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "pkg.flow.uninstallResult";
      requestId: string;
      ok: true;
      output: string;
      /** Files whose on-disk hash no longer matched the recorded one —
       * deleted anyway (git history still has them), listed so the user
       * knows local edits went with them. */
      modifiedFiles: string[];
    }
  | {
      type: "pkg.flow.uninstallResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "pkg.flow.updateResult";
      requestId: string;
      ok: true;
      version: string;
      output: string;
      typecheck: TypecheckOutcome;
    }
  | {
      type: "pkg.flow.updateResult";
      requestId: string;
      ok: false;
      error: string;
      /** Present when the failure is "locally modified files, no force" —
       * lets the UI render a "force update" affordance without parsing the
       * error string. */
      modifiedFiles?: string[];
    }
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
  | { type: "chat.event"; event: ChatEvent }
  | { type: "chat.newSessionResult"; requestId: string; ok: true }
  | {
      type: "chat.newSessionResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "chat.sessionsResult";
      requestId: string;
      ok: true;
      sessions: ChatSessionSummary[];
    }
  | { type: "chat.sessionsResult"; requestId: string; ok: false; error: string }
  | {
      type: "chat.resumeSessionResult";
      requestId: string;
      ok: true;
      sessionId: string;
    }
  | {
      type: "chat.resumeSessionResult";
      requestId: string;
      ok: false;
      error: string;
    }
  /** Unsolicited broadcast (no requestId, same family as "log"/
   * "palette.updated") — fired whenever the coordinator's current chat
   * session changes (new or resumed), so every connected tab's view stays
   * in sync (session switching is global, not per-tab — see
   * agent/runner.ts). Replaces the client's whole chatEvents state, unlike
   * "chat.event" which appends one. */
  | { type: "chat.historyReset"; events: ChatEvent[] }
  | { type: "pong"; requestId: string };
