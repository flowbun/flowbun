import type { Database } from "bun:sqlite";
import type { AnyBlockDef } from "../block";
import type { LoadedFlow, LoadedNode } from "../router/types";
import { blockScopeKey, makeStateScope } from "../state/state-api";
import type { Wiring } from "./schema";
import { parsePortRef } from "./schema";

export interface BlockRegistryEntry {
  def: AnyBlockDef;
  /** Import specifier used for typecheck-glue generation, relative to <dataDir>/generated, e.g. "../blocks/debounce" or "flowbun/hass/trigger". */
  specifier: string;
  /** Real, absolute (for user blocks) import()-able path — what a flow-host Worker actually loads. */
  modulePath: string;
}

/** Keyed by block name as referenced in wiring JSON, e.g. "debounce" or "@hass/trigger". */
export type BlockRegistry = Map<string, BlockRegistryEntry>;

export class FlowAssemblyError extends Error {}

export function assembleFlow(
  wiring: Wiring,
  registry: BlockRegistry,
  db: Database,
): LoadedFlow {
  const nodes = new Map<string, LoadedNode>();
  const globalState = makeStateScope(db, "global", "");
  const flowState = makeStateScope(db, "flow", wiring.name);

  for (const [nodeId, nodeDef] of Object.entries(wiring.nodes)) {
    const entry = registry.get(nodeDef.block);
    if (!entry) {
      throw new FlowAssemblyError(
        `flow "${wiring.name}" node "${nodeId}" references unknown block "${nodeDef.block}"`,
      );
    }
    const config =
      nodeDef.config !== undefined
        ? { ...(entry.def.config as object), ...(nodeDef.config as object) }
        : entry.def.config;
    nodes.set(nodeId, {
      nodeId,
      block: entry.def,
      blockSpecifier: entry.specifier,
      blockModulePath: entry.modulePath,
      config,
      blockState: makeStateScope(
        db,
        "block",
        blockScopeKey(wiring.name, nodeId),
      ),
    });
  }

  const wireIndex = new Map<string, Array<{ nodeId: string; port: string }>>();
  for (const [srcRef, dstRef] of wiring.wires) {
    const src = parsePortRef(srcRef);
    const dst = parsePortRef(dstRef);
    const srcNode = nodes.get(src.nodeId);
    const dstNode = nodes.get(dst.nodeId);
    if (!srcNode) {
      throw new FlowAssemblyError(
        `flow "${wiring.name}" wire references unknown node "${src.nodeId}"`,
      );
    }
    if (!dstNode) {
      throw new FlowAssemblyError(
        `flow "${wiring.name}" wire references unknown node "${dst.nodeId}"`,
      );
    }
    if (!(src.port in srcNode.block.outputs)) {
      throw new FlowAssemblyError(
        `flow "${wiring.name}" wire "${srcRef}" -> "${dstRef}": block "${srcNode.block.name}" has no output port "${src.port}"`,
      );
    }
    if (!(dst.port in dstNode.block.inputs)) {
      throw new FlowAssemblyError(
        `flow "${wiring.name}" wire "${srcRef}" -> "${dstRef}": block "${dstNode.block.name}" has no input port "${dst.port}"`,
      );
    }

    const key = `${src.nodeId}.${src.port}`;
    const list = wireIndex.get(key) ?? [];
    list.push({ nodeId: dst.nodeId, port: dst.port });
    wireIndex.set(key, list);
  }

  return { name: wiring.name, nodes, wireIndex, flowState, globalState };
}
