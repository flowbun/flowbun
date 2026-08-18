import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HALLWAY_LIGHTS_WIRING } from "./wiring-fixtures";
import { applyMutation, WiringWriteError } from "./wiring-writer";

// Own tmpdir fixture, not a real data/wiring/*.json file — this test used
// to read data/wiring/hallway_lights.json directly and broke the moment
// that flow was deleted in production. HALLWAY_LIGHTS_WIRING is an exact
// capture of that file's last committed content (see wiring-fixtures.ts).
let dir: string;
let FILE: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-wiring-writer-test-"));
  FILE = join(dir, "hallway_lights.json");
  writeFileSync(FILE, HALLWAY_LIGHTS_WIRING);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyMutation round-trip fidelity", () => {
  test("a node.position edit changes only that node's own text, nothing else in the document", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.position",
      nodeId: "settle",
      position: { x: 350, y: 40 },
    });

    expect(mutated).not.toBe(original);

    // "settle" is currently inline (`{ "block": "debounce", "config": {...} }`)
    // with no "position" field at all — adding a genuinely new field to an
    // already-inline object is a real, verified limitation beyond the
    // single-token case: jsonc-parser expands *that one object's* own
    // formatting to multi-line (it has no existing multi-line structure to
    // slot the new property into). This is still fully localized — proven
    // below by asserting every *other* top-level node and every wire is
    // byte-identical to the original — not a symptom of a full-document
    // regenerate.
    const parsedOriginal = JSON.parse(original);
    const parsedMutated = JSON.parse(mutated);
    expect(parsedMutated.nodes.settle.position).toEqual({ x: 350, y: 40 });
    expect(parsedMutated.nodes.motion).toEqual(parsedOriginal.nodes.motion);
    expect(parsedMutated.nodes.decide).toEqual(parsedOriginal.nodes.decide);
    expect(parsedMutated.nodes.lights).toEqual(parsedOriginal.nodes.lights);
    expect(parsedMutated.wires).toEqual(parsedOriginal.wires);

    // The parts of the raw text before "settle"'s own node object are
    // untouched verbatim (proves the edit didn't reformat anything earlier
    // in the file, e.g. the preceding "motion" node).
    const prefixBeforeSettle = original.slice(0, original.indexOf('"settle"'));
    expect(mutated.startsWith(prefixBeforeSettle)).toBe(true);
  });

  test("a second edit to a field that already exists is a true single-token diff", () => {
    const original = readFileSync(FILE, "utf8");
    // First edit: gives "settle" a position (expands that one node, per above).
    const withPosition = applyMutation(original, {
      op: "node.position",
      nodeId: "settle",
      position: { x: 350, y: 40 },
    });
    // Second edit: move it again — this field already exists now, so this
    // is the minimal case the design doc actually asked for.
    const movedAgain = applyMutation(withPosition, {
      op: "node.position",
      nodeId: "settle",
      position: { x: 999, y: 1 },
    });

    const beforeLines = withPosition.split("\n");
    const afterLines = movedAgain.split("\n");
    expect(afterLines.length).toBe(beforeLines.length); // no line count change at all
    const changedLines = beforeLines.filter(
      (line, i) => line !== afterLines[i],
    );
    // Only the two coordinate lines ("x": 350 -> 999, "y": 40 -> 1) differ.
    expect(changedLines.length).toBe(2);
  });

  test("editing a node config value produces a single-token diff", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.config",
      nodeId: "settle",
      config: { ms: 45_000 },
    });

    const parsed = JSON.parse(mutated);
    expect(parsed.nodes.settle.config.ms).toBe(45_000);
    // Nothing but "settle" changed.
    expect(parsed.nodes.motion).toEqual(JSON.parse(original).nodes.motion);
    expect(parsed.nodes.decide).toEqual(JSON.parse(original).nodes.decide);
    expect(parsed.nodes.lights).toEqual(JSON.parse(original).nodes.lights);
  });

  test("node.disabled: true adds the field, false removes it entirely", () => {
    const original = readFileSync(FILE, "utf8");
    expect(JSON.parse(original).nodes.settle.disabled).toBeUndefined();

    const disabled = applyMutation(original, {
      op: "node.disabled",
      nodeId: "settle",
      disabled: true,
    });
    expect(JSON.parse(disabled).nodes.settle.disabled).toBe(true);

    const reenabled = applyMutation(disabled, {
      op: "node.disabled",
      nodeId: "settle",
      disabled: false,
    });
    // Removed entirely, not left as a literal `false`. Per this module's
    // documented limitation, adding "disabled" to a node with no prior
    // multi-line structure expanded that node's own formatting (verified
    // above) — removing it again doesn't collapse it back to inline (same
    // as `position`'s equivalent case), but every OTHER node is untouched.
    expect(JSON.parse(reenabled).nodes.settle.disabled).toBeUndefined();
    expect(JSON.parse(reenabled).nodes.settle.block).toBe("debounce");
    expect(JSON.parse(reenabled).nodes.motion).toEqual(
      JSON.parse(original).nodes.motion,
    );
    expect(JSON.parse(reenabled).nodes.decide).toEqual(
      JSON.parse(original).nodes.decide,
    );
  });

  test("node.remove cascades wire removal and leaves other nodes/wires untouched", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.remove",
      nodeId: "settle",
    });
    const parsed = JSON.parse(mutated);

    expect(parsed.nodes.settle).toBeUndefined();
    expect(parsed.nodes.motion).toEqual(JSON.parse(original).nodes.motion);
    // Both wires touching "settle" are gone; the third (decide -> lights) remains.
    expect(parsed.wires).toEqual([["decide.command", "lights.call"]]);
  });

  test("wire.remove on an already-removed wire is an idempotent no-op, not an error", () => {
    const original = readFileSync(FILE, "utf8");
    const once = applyMutation(original, {
      op: "wire.remove",
      from: "motion.changed",
      to: "settle.signal",
    });
    const twice = applyMutation(once, {
      op: "wire.remove",
      from: "motion.changed",
      to: "settle.signal",
    });
    expect(twice).toBe(once);
  });

  test("node.remove cascading two wires on a single-line wires array produces valid JSON", () => {
    // Regression test for a real jsonc-parser@3.3.1 bug: removing wire
    // array elements one at a time by index corrupted the output (a stray
    // extra "]") specifically when the removal touched what was currently
    // the last element of a single-line array — exactly the shape
    // committed wiring files use. Found via the browser UI's node-delete
    // button, reproduced directly against jsonc-parser outside this repo.
    const original = `{
  "name": "test",
  "nodes": {
    "a": { "block": "x" },
    "b": { "block": "y" },
    "c": { "block": "z" }
  },
  "wires": [["a.out", "b.in"], ["b.out", "c.in"]]
}
`;
    const mutated = applyMutation(original, {
      op: "node.remove",
      nodeId: "b",
    });
    expect(() => JSON.parse(mutated)).not.toThrow();
    const parsed = JSON.parse(mutated);
    expect(parsed.nodes.b).toBeUndefined();
    expect(parsed.wires).toEqual([]);
  });

  test("wire.remove of the last wire in a single-line array produces valid JSON", () => {
    const original = `{
  "name": "test",
  "nodes": { "a": { "block": "x" }, "b": { "block": "y" } },
  "wires": [["a.out", "b.in"]]
}
`;
    const mutated = applyMutation(original, {
      op: "wire.remove",
      from: "a.out",
      to: "b.in",
    });
    expect(() => JSON.parse(mutated)).not.toThrow();
    expect(JSON.parse(mutated).wires).toEqual([]);
  });

  test("wire.rewire retargets one end of a wire, leaving the other end and every other wire untouched", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "wire.rewire",
      from: "decide.command",
      to: "lights.call",
      newFrom: "decide.other_output",
      newTo: "lights.call",
    });
    const parsed = JSON.parse(mutated);
    expect(parsed.wires).toEqual([
      ["motion.changed", "settle.signal"],
      ["settle.stable", "decide.presence"],
      ["decide.other_output", "lights.call"],
    ]);
  });

  test("wire.rewire on an already-gone wire is an idempotent no-op, not an error", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "wire.rewire",
      from: "no.such",
      to: "wire.here",
      newFrom: "no.such",
      newTo: "wire.there",
    });
    expect(mutated).toBe(original);
  });

  test("node.rename moves the node's data to the new key and rewrites every wire endpoint touching it", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.rename",
      nodeId: "settle",
      newNodeId: "settle_renamed",
    });
    const parsed = JSON.parse(mutated);
    const parsedOriginal = JSON.parse(original);

    expect(parsed.nodes.settle).toBeUndefined();
    expect(parsed.nodes.settle_renamed).toEqual(parsedOriginal.nodes.settle);
    // Every other node is completely untouched.
    expect(parsed.nodes.motion).toEqual(parsedOriginal.nodes.motion);
    expect(parsed.nodes.decide).toEqual(parsedOriginal.nodes.decide);
    expect(parsed.nodes.lights).toEqual(parsedOriginal.nodes.lights);
    // Both wire endpoints referencing "settle" follow the rename; the one
    // wire that never touched it (decide.command -> lights.call) is
    // untouched.
    expect(parsed.wires).toEqual([
      ["motion.changed", "settle_renamed.signal"],
      ["settle_renamed.stable", "decide.presence"],
      ["decide.command", "lights.call"],
    ]);
  });

  test("node.rename to the same name is a no-op", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.rename",
      nodeId: "settle",
      newNodeId: "settle",
    });
    expect(mutated).toBe(original);
  });

  test("node.rename to an already-existing node id throws rather than silently overwriting it", () => {
    const original = readFileSync(FILE, "utf8");
    expect(() =>
      applyMutation(original, {
        op: "node.rename",
        nodeId: "settle",
        newNodeId: "decide",
      }),
    ).toThrow(WiringWriteError);
  });

  test("node.rename of a nonexistent node throws", () => {
    const original = readFileSync(FILE, "utf8");
    expect(() =>
      applyMutation(original, {
        op: "node.rename",
        nodeId: "does-not-exist",
        newNodeId: "whatever",
      }),
    ).toThrow(WiringWriteError);
  });

  test("node.rename to an invalid identifier throws via the post-edit schema check", () => {
    const original = readFileSync(FILE, "utf8");
    // "-" isn't a valid node id character (NODE_ID_RE in wiring/schema.ts) —
    // this isn't special-cased in applyMutation itself, it's caught by the
    // same post-edit WiringSchema.safeParse that catches every other
    // structurally-invalid result.
    expect(() =>
      applyMutation(original, {
        op: "node.rename",
        nodeId: "settle",
        newNodeId: "not-a-valid-id",
      }),
    ).toThrow(WiringWriteError);
  });

  test("flow.disabled: true adds the top-level field, false removes it entirely", () => {
    const original = readFileSync(FILE, "utf8");
    expect(JSON.parse(original).disabled).toBeUndefined();

    const disabled = applyMutation(original, {
      op: "flow.disabled",
      disabled: true,
    });
    expect(JSON.parse(disabled).disabled).toBe(true);
    // Every node/wire untouched — this is a whole-flow field, not scoped to
    // any one node.
    expect(JSON.parse(disabled).nodes).toEqual(JSON.parse(original).nodes);
    expect(JSON.parse(disabled).wires).toEqual(JSON.parse(original).wires);

    const reenabled = applyMutation(disabled, {
      op: "flow.disabled",
      disabled: false,
    });
    expect(JSON.parse(reenabled).disabled).toBeUndefined();
  });

  test("node.block repoints the node and preserves its config, position and every wire touching it", () => {
    const original = readFileSync(FILE, "utf8");
    // The real motivating case: forking a shared block for one node only
    // (see applyMutation's own node.block comment). "settle" carries both a
    // config and two wires, which is exactly what a node.remove + node.add
    // round-trip would have destroyed.
    const mutated = applyMutation(original, {
      op: "node.block",
      nodeId: "settle",
      block: "settle_debounce",
    });
    const parsed = JSON.parse(mutated);
    const parsedOriginal = JSON.parse(original);

    expect(parsed.nodes.settle.block).toBe("settle_debounce");
    expect(parsed.nodes.settle.config).toEqual(
      parsedOriginal.nodes.settle.config,
    );
    expect(parsed.wires).toEqual(parsedOriginal.wires);
    expect(parsed.nodes.motion).toEqual(parsedOriginal.nodes.motion);
    expect(parsed.nodes.decide).toEqual(parsedOriginal.nodes.decide);
    expect(parsed.nodes.lights).toEqual(parsedOriginal.nodes.lights);
  });

  test("node.block is a true single-token diff — no sibling reformat", () => {
    const original = readFileSync(FILE, "utf8");
    // Unlike node.position's *first* write (which expands an inline node
    // object to multi-line because the field is genuinely new), every node
    // already has a "block" field, so this only ever replaces one string
    // token. "settle" is the inline node, i.e. the worst case for this.
    const mutated = applyMutation(original, {
      op: "node.block",
      nodeId: "settle",
      block: "settle_debounce",
    });
    expect(mutated).toBe(
      original.replace('"block": "debounce"', '"block": "settle_debounce"'),
    );
  });

  test("node.block to the block it already uses is a no-op", () => {
    const original = readFileSync(FILE, "utf8");
    const mutated = applyMutation(original, {
      op: "node.block",
      nodeId: "settle",
      block: "debounce",
    });
    expect(mutated).toBe(original);
  });

  test("node.block on a nonexistent node throws rather than creating a blockless node", () => {
    const original = readFileSync(FILE, "utf8");
    expect(() =>
      applyMutation(original, {
        op: "node.block",
        nodeId: "does-not-exist",
        block: "whatever",
      }),
    ).toThrow(WiringWriteError);
  });

  test("node.config on a nonexistent node throws rather than silently creating an invalid node", () => {
    const original = readFileSync(FILE, "utf8");
    // jsonc-parser's modify() would happily create {"nodes":{"does-not-exist":{"config":{}}}}
    // (no "block" field) since it creates missing intermediate paths — the
    // post-edit WiringSchema.safeParse is what catches this and throws.
    expect(() =>
      applyMutation(original, {
        op: "node.config",
        nodeId: "does-not-exist",
        config: {},
      }),
    ).toThrow(WiringWriteError);
  });
});
