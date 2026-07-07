import { parsePortRef, WiringSchema } from "flowbun";
import type { WiringMutation } from "flowbun/ws";
import { applyEdits, modify } from "jsonc-parser";

const FMT = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

export class WiringWriteError extends Error {}

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
      // Cascade: drop every wire touching this node first, in descending
      // index order so earlier indices stay valid across the sequential edits.
      const doomed = current.wires
        .map((_, i) => i)
        .filter((i) => {
          const wire = current.wires[i] as [string, string];
          return (
            parsePortRef(wire[0]).nodeId === mutation.nodeId ||
            parsePortRef(wire[1]).nodeId === mutation.nodeId
          );
        })
        .sort((a, b) => b - a);
      for (const idx of doomed) edit(["wires", idx], undefined);
      edit(["nodes", mutation.nodeId], undefined);
      break;
    }
    case "node.config":
      edit(["nodes", mutation.nodeId, "config"], mutation.config);
      break;
    case "node.position":
      edit(["nodes", mutation.nodeId, "position"], mutation.position);
      break;
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
      edit(["wires", idx], undefined);
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
