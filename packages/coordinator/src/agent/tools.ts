import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Wiring } from "flowbun";
import type { ActionCall } from "flowbun/hass/action";
import type { EntityStateReading } from "flowbun/hass/client";
import type {
  BlockPaletteEntry,
  FlowEntry,
  HassEntitySummary,
  TypecheckOutcome,
  WiringMutation,
} from "flowbun/ws";
import { formatWithBiome } from "../format-block";
import type { UndoStack } from "../undo-stack";
import {
  applyMutation,
  describeMutation,
  WiringWriteError,
} from "../wiring-writer";
import { isSafeBlockFilename } from "../ws-server";

/**
 * The subset of WsServerDeps (main.ts) an agent tool needs — deliberately
 * narrower: no `supervisor`/`logBuffer`/`chatEvents`/`gitSnapshotter`/
 * `getSystemStats`/`queryDb`. main.ts's real `deps` object structurally
 * satisfies this (it has strictly more fields), so the exact same object
 * already passed to `startWsServer` is passed here too — no refactor, no
 * duplicated state.
 */
export interface AgentToolDeps {
  dataDir: string;
  repoRoot: string;
  flows: Map<string, FlowEntry>;
  undoStack: UndoStack;
  getPalette: () => BlockPaletteEntry[];
  reloadWiringFile: (path: string, label?: string) => Promise<TypecheckOutcome>;
  reloadBlocksAndRestartAll: (label?: string) => Promise<TypecheckOutcome>;
  createFlow: (name: string) => Promise<{ file: string; wiring: Wiring }>;
  createBlock: (name: string) => Promise<{ file: string; source: string }>;
  deleteBlock: (file: string) => Promise<void>;
  deleteFlow: (file: string) => Promise<void>;
  listHassEntities: () => Promise<HassEntitySummary[]>;
  /** See Supervisor.queryHassState — errors are transport failures, an
   * undefined reading is HA genuinely not knowing the entity. */
  queryHassState: (
    entity: string,
  ) => Promise<
    | { ok: true; reading: EntityStateReading | undefined }
    | { ok: false; error: string }
  >;
  /** See Supervisor.requestHassAction. Whether this is a dry-run is decided
   * by the DEPLOYMENT (main.ts wires in the process-wide FLOWBUN_DRY_RUN),
   * never by the tool's caller — the model cannot opt out of dry-run. */
  callHassService: (
    call: ActionCall,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** The process-wide dry-run flag, surfaced so hass_call_service can SAY
   * "dry-run, nothing really happened" in its summary instead of letting
   * the model believe a suppressed call took effect. */
  isDryRun: () => boolean;
  markSelfWrite: (path: string) => void;
}

/**
 * Never throws — every handler catches its own failures and returns
 * `ok:false` instead, so both mcp-server.ts's CallToolResult wrapping and
 * unit tests have one uniform shape to check, with no try/catch needed at
 * either call site. `summary` is what the model actually sees: for a write,
 * a short human description of what changed (mirrors the git commit label);
 * for a read, the actual requested data (JSON or raw source), since that IS
 * the tool's output, not a side note about it.
 */
export interface ToolResult {
  ok: boolean;
  summary: string;
  error?: string;
}

/** Mirrors ws-server.ts's "wiring.mutate" case exactly — same write, same
 * typecheck-gated reload, same undo tracking — just invoked in-process by
 * the agent instead of over the WS wire. The "agent: " commit-label prefix
 * (reserved for this from the git-snapshot feature) is what lets `git log`/
 * the History panel visibly distinguish agent edits from human ones. */
export async function wiringMutateHandler(
  deps: AgentToolDeps,
  input: { file: string; mutation: WiringMutation },
): Promise<ToolResult> {
  try {
    const entry = deps.flows.get(input.file);
    if (!entry) {
      throw new WiringWriteError(`unknown wiring file "${input.file}"`);
    }
    const path = join(deps.dataDir, "wiring", input.file);
    const currentText = readFileSync(path, "utf8");
    const nextText = applyMutation(currentText, input.mutation);
    writeFileSync(path, nextText);
    // Before the reload below, not after — see ws-server.ts's
    // "wiring.mutate" case for why (same write path, same race).
    deps.markSelfWrite(path);
    const description = describeMutation(input.mutation);
    const typecheck = await deps.reloadWiringFile(
      path,
      `agent: ${input.file}: ${description}`,
    );
    await deps.undoStack.recordEdit(join("wiring", input.file));
    if (!typecheck.ok) {
      return {
        ok: false,
        summary: `Wrote ${input.file} (${description}) but it failed typecheck`,
        error: typecheck.output,
      };
    }
    return { ok: true, summary: `${description} in ${input.file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to mutate ${input.file}`,
      error: String(err),
    };
  }
}

/** Mirrors ws-server.ts's "block.write" case exactly. */
export async function blockWriteHandler(
  deps: AgentToolDeps,
  input: { file: string; source: string },
): Promise<ToolResult> {
  if (!isSafeBlockFilename(input.file)) {
    return {
      ok: false,
      summary: `Invalid block filename "${input.file}"`,
      error: `invalid block filename "${input.file}"`,
    };
  }
  try {
    const path = join(deps.dataDir, "blocks", input.file);
    const relPath = join("blocks", input.file);
    const formatted = await formatWithBiome(
      input.source,
      relative(deps.repoRoot, path),
      deps.repoRoot,
    );
    writeFileSync(path, formatted);
    deps.markSelfWrite(path);
    const typecheck = await deps.reloadBlocksAndRestartAll(
      `agent: block write: ${input.file}`,
    );
    await deps.undoStack.recordEdit(relPath);
    if (!typecheck.ok) {
      return {
        ok: false,
        summary: `Wrote ${input.file} but it failed typecheck`,
        error: typecheck.output,
      };
    }
    return { ok: true, summary: `Wrote ${input.file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to write ${input.file}`,
      error: String(err),
    };
  }
}

export async function blockCreateHandler(
  deps: AgentToolDeps,
  input: { name: string },
): Promise<ToolResult> {
  try {
    const { file } = await deps.createBlock(input.name);
    return { ok: true, summary: `Created block ${file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to create block "${input.name}"`,
      error: String(err),
    };
  }
}

export async function blockDeleteHandler(
  deps: AgentToolDeps,
  input: { file: string },
): Promise<ToolResult> {
  try {
    await deps.deleteBlock(input.file);
    return { ok: true, summary: `Deleted block ${input.file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to delete block "${input.file}"`,
      error: String(err),
    };
  }
}

export async function flowCreateHandler(
  deps: AgentToolDeps,
  input: { name: string },
): Promise<ToolResult> {
  try {
    const { file } = await deps.createFlow(input.name);
    return { ok: true, summary: `Created flow ${file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to create flow "${input.name}"`,
      error: String(err),
    };
  }
}

export async function flowDeleteHandler(
  deps: AgentToolDeps,
  input: { file: string },
): Promise<ToolResult> {
  try {
    await deps.deleteFlow(input.file);
    return { ok: true, summary: `Deleted flow ${input.file}` };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to delete flow "${input.file}"`,
      error: String(err),
    };
  }
}

export async function flowReadHandler(
  deps: AgentToolDeps,
  input: { file: string },
): Promise<ToolResult> {
  try {
    const entry = deps.flows.get(input.file);
    if (!entry) {
      return {
        ok: false,
        summary: `No such flow "${input.file}"`,
        error: `unknown wiring file "${input.file}"`,
      };
    }
    return { ok: true, summary: JSON.stringify(entry.wiring, null, 2) };
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to read flow "${input.file}"`,
      error: String(err),
    };
  }
}

export async function listFlowsHandler(
  deps: AgentToolDeps,
): Promise<ToolResult> {
  try {
    const summaries = [...deps.flows.values()].map((e) => ({
      file: e.file,
      name: e.wiring.name,
      nodeCount: Object.keys(e.wiring.nodes).length,
      wireCount: e.wiring.wires.length,
      status: e.status.kind,
    }));
    return { ok: true, summary: JSON.stringify(summaries, null, 2) };
  } catch (err) {
    return {
      ok: false,
      summary: "Failed to list flows",
      error: String(err),
    };
  }
}

export async function listBlocksHandler(
  deps: AgentToolDeps,
): Promise<ToolResult> {
  try {
    return { ok: true, summary: JSON.stringify(deps.getPalette(), null, 2) };
  } catch (err) {
    return {
      ok: false,
      summary: "Failed to list blocks",
      error: String(err),
    };
  }
}

export async function blockReadHandler(
  deps: AgentToolDeps,
  input: { file: string },
): Promise<ToolResult> {
  if (!isSafeBlockFilename(input.file)) {
    return {
      ok: false,
      summary: `Invalid block filename "${input.file}"`,
      error: `invalid block filename "${input.file}"`,
    };
  }
  try {
    const source = readFileSync(
      join(deps.dataDir, "blocks", input.file),
      "utf8",
    );
    return { ok: true, summary: source };
  } catch (err) {
    return {
      ok: false,
      summary: `Could not read block "${input.file}"`,
      error: String(err),
    };
  }
}

export async function hassEntitiesHandler(
  deps: AgentToolDeps,
): Promise<ToolResult> {
  const entities = await deps.listHassEntities();
  return { ok: true, summary: JSON.stringify(entities) };
}

export async function hassGetStateHandler(
  deps: AgentToolDeps,
  input: { entity: string },
): Promise<ToolResult> {
  const result = await deps.queryHassState(input.entity);
  if (!result.ok) {
    return {
      ok: false,
      summary: `Could not read "${input.entity}"`,
      error: result.error,
    };
  }
  if (result.reading === undefined) {
    return {
      ok: false,
      summary: `Home Assistant has no entity "${input.entity}"`,
      error: `unknown entity "${input.entity}" — use hass_entities to list real entity ids`,
    };
  }
  return { ok: true, summary: JSON.stringify(result.reading) };
}

export async function hassCallServiceHandler(
  deps: AgentToolDeps,
  input: {
    domain: string;
    service: string;
    entity_id?: string | string[];
    data?: Record<string, unknown>;
  },
): Promise<ToolResult> {
  if (!input.domain || !input.service) {
    return {
      ok: false,
      summary: "hass_call_service needs both a domain and a service",
      error: "missing domain and/or service",
    };
  }
  const call: ActionCall = {
    domain: input.domain,
    service: input.service,
    ...(input.entity_id ? { target: { entity_id: input.entity_id } } : {}),
    ...(input.data ? { data: input.data } : {}),
  };
  const result = await deps.callHassService(call);
  const label = `${input.domain}.${input.service}${
    input.entity_id ? ` on ${JSON.stringify(input.entity_id)}` : ""
  }`;
  if (!result.ok) {
    return {
      ok: false,
      summary: `Failed to call ${label}`,
      error: result.error ?? "unknown error",
    };
  }
  // Never let the model mistake a suppressed dry-run call for a real one.
  return deps.isDryRun()
    ? {
        ok: true,
        summary: `DRY-RUN: ${label} was accepted but NOT actually executed (this deployment has FLOWBUN_DRY_RUN enabled)`,
      }
    : { ok: true, summary: `Called ${label}` };
}
