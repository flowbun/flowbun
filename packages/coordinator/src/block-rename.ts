import type { BlockPaletteEntry, FlowEntry } from "flowbun/ws";
import { applyMutation } from "./wiring-writer";

/**
 * The decision half of renaming a block through the editor, kept out of
 * ws-server.ts's request closure so it can be tested without standing up a
 * WebSocket server: everything here is pure, and ws-server does only the
 * file IO around it.
 *
 * The bug this exists for: saving a new `name:` field used to change only the
 * block. discoverBlocks then registered it under the new name, the old name
 * simply stopped existing, and every node still referencing it failed
 * assembleFlow with `references unknown block "<old>"` — the flow marked
 * failed and left running its old code, and on canvas the node losing its
 * ports entirely (its palette `def` lookup misses), so its wires couldn't
 * render. The block editor's name field describes itself as "referenced by
 * nodes that use this block"; this is what makes that true.
 */

/**
 * The palette entry that would collide with `newName`, if any — `ownFile` is
 * excluded so re-saving a block under its existing name never self-collides.
 *
 * Refusing a collision matters more than it looks: discoverBlocks resolves
 * one by *skipping the file*. A user block taking a reserved `@core/*` /
 * `@hass/*` / `@ai/*` built-in name is dropped with only a
 * `[discoverBlocks] ... reserved` log line, and two user blocks sharing a
 * name resolve by scan order, so the loser vanishes from the palette with
 * its source still on disk. Renaming into either case would repoint live
 * nodes at a block that was never going to load.
 *
 * Takes the palette rather than the BlockRegistry because it carries exactly
 * the two fields needed and no more: `name`, and a `file` that is undefined
 * precisely for the built-ins whose namespace is reserved.
 */
export function findBlockNameClash(
  palette: BlockPaletteEntry[],
  newName: string,
  ownFile: string,
): BlockPaletteEntry | undefined {
  return palette.find((e) => e.name === newName && e.file !== ownFile);
}

/** Human-readable reason for a clash, distinguishing the reserved-namespace
 * case (no `file`) from a plain collision with another add-on block. */
export function describeBlockNameClash(clash: BlockPaletteEntry): string {
  return clash.file
    ? `block name "${clash.name}" is already used by ${clash.file}`
    : `block name "${clash.name}" is reserved by a built-in block`;
}

/**
 * Which nodes, in which wiring files, currently reference `oldName`.
 *
 * A flow whose JSON doesn't parse at all isn't in the flows map and so isn't
 * planned for. That's the honest outcome rather than a gap: applyMutation
 * couldn't rewrite such a file either, and it is already failing loudly for
 * its own unrelated reason.
 */
export function planBlockRepoint(
  flows: Iterable<FlowEntry>,
  oldName: string,
): Array<{ file: string; nodeIds: string[] }> {
  const plan: Array<{ file: string; nodeIds: string[] }> = [];
  for (const entry of flows) {
    const nodeIds = Object.entries(entry.wiring.nodes)
      .filter(([, node]) => node.block === oldName)
      .map(([id]) => id);
    if (nodeIds.length > 0) plan.push({ file: entry.file, nodeIds });
  }
  return plan;
}

/**
 * Rewrites one wiring file's text so every listed node points at `newName`.
 *
 * One node.block mutation at a time against the accumulating text rather
 * than a regenerate: each is a single-token `"block"` value replacement (see
 * wiring-writer's node.block case), so N nodes in a file cost N minimal
 * edits and the file stays as human-diffable as it was.
 */
export function repointWiringText(
  text: string,
  nodeIds: string[],
  newName: string,
): string {
  let next = text;
  for (const nodeId of nodeIds) {
    next = applyMutation(next, { op: "node.block", nodeId, block: newName });
  }
  return next;
}
