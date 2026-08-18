import { parsePortRef, WiringSchema } from "flowbun";
import type { WiringMutation } from "flowbun/ws";
import { applyEdits, modify } from "jsonc-parser";

const FMT = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

export class WiringWriteError extends Error {}

/** A short human label for a mutation's git commit message — see
 * snapshotting-serializer.ts. */
export function describeMutation(mutation: WiringMutation): string {
  switch (mutation.op) {
    case "node.add":
      return `add node: ${mutation.nodeId} (${mutation.block})`;
    case "node.remove":
      return `remove node: ${mutation.nodeId}`;
    case "node.config":
      return `node.config: ${mutation.nodeId}`;
    case "node.block":
      return `repoint node: ${mutation.nodeId} -> ${mutation.block}`;
    case "node.position":
      return `move node: ${mutation.nodeId}`;
    case "node.disabled":
      return `${mutation.disabled ? "disable" : "enable"} node: ${mutation.nodeId}`;
    case "flow.disabled":
      return mutation.disabled ? "disable flow" : "enable flow";
    case "node.rename":
      return `rename node: ${mutation.nodeId} -> ${mutation.newNodeId}`;
    case "wire.add":
      return `add wire: ${mutation.from} -> ${mutation.to}`;
    case "wire.remove":
      return `remove wire: ${mutation.from} -> ${mutation.to}`;
    case "wire.rewire":
      return `rewire: ${mutation.from} -> ${mutation.to}`;
  }
}

/**
 * Applies exactly one mutation to a wiring file's raw text and returns the
 * new text — never touches disk itself (the caller writes after this
 * returns). Canonicalization contract: untouched regions of the file are
 * byte-for-byte unchanged — this is a surgical jsonc-parser patch, never a
 * full-document `JSON.stringify` regenerate (verified: a naive regenerate,
 * even reformatted with this repo's own Biome, does not reproduce the mix
 * of inline/expanded objects already in the committed wiring files, since
 * Biome preserves whichever bracket style text already has rather than
 * computing one from width). New/changed content is emitted 2-space
 * indent, LF, matching the repo's convention.
 *
 * Known, verified limitations, both bounded to the one node/sibling
 * involved, never file-wide:
 * - node.add/wire.add (an object/array append) re-expand whichever sibling
 *   immediately precedes the insertion point, since jsonc-parser has to
 *   emit "prev-prop + comma + new-prop" as one edit.
 * - wire.remove and node.remove's wire cascade replace the *whole* `wires`
 *   array in one edit rather than removing individual elements by index.
 *   This isn't a style choice: jsonc-parser@3.3.1's modify() has a real bug
 *   where removing what is currently the last element of a single-line
 *   array (exactly the shape `data/wiring/*.json` commits wires in)
 *   corrupts the output with a stray extra `]` — reproduced directly
 *   against the library outside this codebase. Removing anything but the
 *   last element, or an array that's already multi-line, isn't affected,
 *   which is exactly why this slipped past the original test suite. The
 *   whole-array replace costs the same "sibling reformat" tradeoff
 *   wire.add already has, and is always correct.
 * - The *first* node.position (or any field genuinely new to that node,
 *   e.g. a freshly-committed file that predates positions existing at all)
 *   expands that one node's own object to multi-line, since there's no
 *   existing multi-line structure to slot the new property into inline.
 *   Once a node has been touched once, every subsequent edit to a field
 *   that already exists (moving it again, changing config) is a true
 *   single-token diff — see wiring-writer.test.ts for both cases proven
 *   against the real committed hallway_lights.json.
 */
export function applyMutation(
  currentText: string,
  mutation: WiringMutation,
): string {
  const current = WiringSchema.parse(JSON.parse(currentText));
  let text = currentText;
  const edit = (
    path: (string | number)[],
    value: unknown,
    isArrayInsertion = false,
  ) => {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: FMT, isArrayInsertion }),
    );
  };

  switch (mutation.op) {
    case "node.add": {
      if (mutation.nodeId in current.nodes) {
        throw new WiringWriteError(`node "${mutation.nodeId}" already exists`);
      }
      edit(["nodes", mutation.nodeId], {
        block: mutation.block,
        ...(mutation.config !== undefined ? { config: mutation.config } : {}),
        position: mutation.position,
      });
      break;
    }
    case "node.remove": {
      // Cascade: drop every wire touching this node first. Removing wires
      // one at a time by index (even in descending order) hits a real
      // jsonc-parser@3.3.1 bug: modify() corrupts the output when the edit
      // removes what is currently the *last* element of a single-line
      // array (verified directly against the library — see the scratch
      // repro that motivated this fix). Replacing the whole `wires` array
      // in one edit sidesteps that bug entirely; it costs the same
      // accepted "whole-array reformat" tradeoff `wire.add` already has.
      const survivors = current.wires.filter((wire) => {
        const [a, b] = wire as [string, string];
        return (
          parsePortRef(a).nodeId !== mutation.nodeId &&
          parsePortRef(b).nodeId !== mutation.nodeId
        );
      });
      if (survivors.length !== current.wires.length) {
        edit(["wires"], survivors);
      }
      edit(["nodes", mutation.nodeId], undefined);
      break;
    }
    case "node.config":
      edit(["nodes", mutation.nodeId, "config"], mutation.config);
      break;
    case "node.block": {
      if (!(mutation.nodeId in current.nodes)) {
        throw new WiringWriteError(`node "${mutation.nodeId}" does not exist`);
      }
      if (current.nodes[mutation.nodeId]?.block === mutation.block) break; // no-op
      // Deliberately patches *only* `block`, leaving this node's wires,
      // position, config and `disabled` flag exactly as they were — which is
      // the entire reason this op exists rather than the editor doing
      // node.remove + node.add. The motivating flow is "fork this built-in
      // block for just this node" (main.ts's forkBlockForNode): a user who
      // clicks ✎ on a @core/scheduler node to customize it must not silently
      // lose the wires feeding it. Unlike node.position's first write, every
      // node already has a `block` field, so this is a genuine single-token
      // diff with no sibling reformat.
      //
      // No check that `mutation.block` names a block that actually exists.
      // That's assembleFlow's "references unknown block" error, surfaced by
      // reloadWiringFileInner's structural-failure branch (main.ts): the
      // already-running flow is left completely untouched, its status goes to
      // failed-typecheck, and the edit sits on the undo stack. Re-validating
      // here would be a second, weaker copy of a check that path already
      // makes properly — see the repo's two-tier trust rule. Note this does
      // mean a caller must confirm its new block actually *registered* before
      // repointing a node at it; main.ts's forkBlockForNode does exactly
      // that, because a block file that fails to import is skipped silently
      // by discoverBlocks rather than failing anything.
      edit(["nodes", mutation.nodeId, "block"], mutation.block);
      break;
    }
    case "node.position":
      edit(["nodes", mutation.nodeId, "position"], mutation.position);
      break;
    case "node.disabled":
      // Omit the field entirely when re-enabling (undefined = delete),
      // rather than writing a literal "disabled": false — keeps a normal,
      // enabled node's committed JSON exactly as clean as before this
      // feature existed.
      edit(
        ["nodes", mutation.nodeId, "disabled"],
        mutation.disabled ? true : undefined,
      );
      break;
    case "flow.disabled":
      // Same "omit rather than write false" convention as node.disabled,
      // one level up — this is the top-level field WiringSchema.disabled
      // reads, not scoped to any one node.
      edit(["disabled"], mutation.disabled ? true : undefined);
      break;
    case "node.rename": {
      if (mutation.newNodeId === mutation.nodeId) break; // no-op
      if (!(mutation.nodeId in current.nodes)) {
        throw new WiringWriteError(`node "${mutation.nodeId}" does not exist`);
      }
      if (mutation.newNodeId in current.nodes) {
        throw new WiringWriteError(
          `node "${mutation.newNodeId}" already exists`,
        );
      }
      // jsonc-parser's modify() has no primitive for "rename an object
      // key" -- only set/delete-at-path -- so this is move-by-copy: write
      // the node's existing data under the new key, then delete the old
      // one. Same "accept a sibling reformat" tradeoff node.add/
      // node.remove already make, and the new key lands at the end of
      // `nodes` rather than at the old key's position, matching how
      // node.add already behaves (no attempt to preserve position).
      const nodeData = current.nodes[mutation.nodeId];
      // Every wire endpoint referencing the old id must move with it, in
      // the same mutation -- otherwise the file would pass through an
      // invalid intermediate state (a wire pointing at a node id that no
      // longer exists) even if only for the instant between two edits.
      // Whole-array replace, not per-index edits, for the same reason
      // node.remove's wire cascade uses one (see its own comment): a
      // per-index edit trips a real jsonc-parser bug on a single-line
      // array's last element.
      const renamed = current.wires.map((wire) => {
        const [a, b] = wire as [string, string];
        const renameEndpoint = (ref: string) => {
          const parsed = parsePortRef(ref);
          return parsed.nodeId === mutation.nodeId
            ? `${mutation.newNodeId}.${parsed.port}`
            : ref;
        };
        return [renameEndpoint(a), renameEndpoint(b)];
      });
      const wiresChanged = renamed.some(([a, b], i) => {
        const [origA, origB] = current.wires[i] as [string, string];
        return a !== origA || b !== origB;
      });
      if (wiresChanged) edit(["wires"], renamed);
      edit(["nodes", mutation.newNodeId], nodeData);
      edit(["nodes", mutation.nodeId], undefined);
      break;
    }
    case "wire.add":
      edit(["wires", current.wires.length], [mutation.from, mutation.to], true);
      break;
    case "wire.remove": {
      const idx = current.wires.findIndex(
        ([a, b]) => a === mutation.from && b === mutation.to,
      );
      // Already gone: idempotent no-op, not an error — React Flow can fire
      // both a node.remove (server-side cascade) and a wire.remove for the
      // same edge in one user gesture.
      if (idx === -1) break;
      // Whole-array replace, not a per-index removal — see the node.remove
      // case above for why (the same jsonc-parser last-element-removal bug
      // applies here whenever the deleted wire happens to be the last one).
      edit(
        ["wires"],
        current.wires.filter((_, i) => i !== idx),
      );
      break;
    }
    case "wire.rewire": {
      const idx = current.wires.findIndex(
        ([a, b]) => a === mutation.from && b === mutation.to,
      );
      // Same idempotent-no-op posture as wire.remove: the wire the canvas
      // thought it was retargeting is already gone (a concurrent edit, or
      // this same click landing twice).
      if (idx === -1) break;
      edit(
        ["wires"],
        current.wires.map((wire, i) =>
          i === idx ? [mutation.newFrom, mutation.newTo] : wire,
        ),
      );
      break;
    }
  }

  const result = WiringSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new WiringWriteError(
      `resulting wiring is invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return text;
}
