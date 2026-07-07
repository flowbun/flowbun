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

export interface FlowEntry {
  /** Filename under data/wiring/, e.g. "hallway_lights.json" — the handle
   * every wiring-scoped command uses. Not an absolute path: the client has
   * no business knowing the coordinator's filesystem layout, and this also
   * doubles as the whitelist the server checks writes against. */
  file: string;
  wiring: Wiring;
  status: FlowStatus;
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
  | { op: "wire.add"; from: string; to: string } // "nodeId.port" refs, per parsePortRef
  | { op: "wire.remove"; from: string; to: string };

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
  | { type: "flow.restart"; requestId: string; flow: string };

// ---------- coordinator -> browser ----------
export type ServerToClient =
  | {
      type: "snapshot";
      flows: FlowEntry[];
      palette: BlockPaletteEntry[];
      logs: LogRecord[];
    }
  | { type: "flow.updated"; file: string; wiring: Wiring }
  | { type: "flow.status"; flow: string; status: FlowStatus }
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
      type: "block.writeResult";
      requestId: string;
      ok: true;
      typecheck: TypecheckOutcome;
    }
  | { type: "block.writeResult"; requestId: string; ok: false; error: string }
  | { type: "block.readResult"; requestId: string; ok: true; source: string }
  | { type: "block.readResult"; requestId: string; ok: false; error: string }
  | { type: "flow.restartResult"; requestId: string; ok: true }
  | { type: "flow.restartResult"; requestId: string; ok: false; error: string };
