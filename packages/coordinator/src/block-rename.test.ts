import { describe, expect, test } from "bun:test";
import type { BlockPaletteEntry, FlowEntry } from "flowbun/ws";
import {
  describeBlockNameClash,
  findBlockNameClash,
  planBlockRepoint,
  repointWiringText,
} from "./block-rename";
import { HALLWAY_LIGHTS_WIRING } from "./wiring-fixtures";

function paletteEntry(name: string, file?: string): BlockPaletteEntry {
  return { name, file, inputs: {}, outputs: {}, defaultConfig: {} };
}

/** Only the two fields planBlockRepoint actually reads — the rest of
 * FlowEntry (status, undo) is irrelevant to the plan and would be noise. */
function flowEntry(file: string, nodes: Record<string, string>): FlowEntry {
  return {
    file,
    wiring: {
      name: file.replace(/\.json$/, ""),
      nodes: Object.fromEntries(
        Object.entries(nodes).map(([id, block]) => [id, { block }]),
      ),
      wires: [],
    },
    status: { kind: "starting" },
    undo: { canUndo: false, canRedo: false },
  } as FlowEntry;
}

const PALETTE = [
  paletteEntry("@core/scheduler"), // built-in: no file
  paletteEntry("@hass/action"),
  paletteEntry("debounce", "debounce.ts"),
  paletteEntry("matrix_poll", "matrix_poll.ts"),
];

describe("findBlockNameClash", () => {
  test("a free name doesn't clash", () => {
    expect(
      findBlockNameClash(PALETTE, "rowing_poll", "matrix_poll.ts"),
    ).toBeUndefined();
  });

  test("re-saving a block under its own existing name never self-clashes", () => {
    // The whole reason findBlockNameClash takes ownFile: every ordinary save
    // re-writes a name that is, by definition, already in the palette.
    expect(
      findBlockNameClash(PALETTE, "matrix_poll", "matrix_poll.ts"),
    ).toBeUndefined();
  });

  test("clashes with another add-on block", () => {
    const clash = findBlockNameClash(PALETTE, "debounce", "matrix_poll.ts");
    expect(clash?.file).toBe("debounce.ts");
    expect(describeBlockNameClash(clash as BlockPaletteEntry)).toBe(
      'block name "debounce" is already used by debounce.ts',
    );
  });

  test("clashes with a reserved built-in name, reported as reserved rather than as a file", () => {
    // discoverBlocks would skip the file entirely for this one (reserved
    // namespace) — the palette entry has no `file`, which is exactly how the
    // built-in/add-on split is represented, so the message must differ.
    const clash = findBlockNameClash(
      PALETTE,
      "@core/scheduler",
      "matrix_poll.ts",
    );
    expect(clash?.file).toBeUndefined();
    expect(describeBlockNameClash(clash as BlockPaletteEntry)).toBe(
      'block name "@core/scheduler" is reserved by a built-in block',
    );
  });
});

describe("planBlockRepoint", () => {
  const FLOWS = [
    flowEntry("rowing_wa.json", {
      weekly_scheduler: "@core/scheduler",
      send_poll: "matrix_poll",
      poll_debug: "@core/debug",
    }),
    flowEntry("other.json", {
      a: "matrix_poll",
      b: "matrix_poll",
      c: "debounce",
    }),
    flowEntry("unrelated.json", { x: "debounce" }),
  ];

  test("finds every referencing node across every flow, and skips flows with none", () => {
    expect(planBlockRepoint(FLOWS, "matrix_poll")).toEqual([
      { file: "rowing_wa.json", nodeIds: ["send_poll"] },
      { file: "other.json", nodeIds: ["a", "b"] },
    ]);
  });

  test("an unreferenced block plans nothing — the ordinary rename-a-fresh-block case", () => {
    expect(planBlockRepoint(FLOWS, "never_used")).toEqual([]);
  });

  test("built-in names are planned for like any other, since a fork can be renamed too", () => {
    expect(planBlockRepoint(FLOWS, "@core/scheduler")).toEqual([
      { file: "rowing_wa.json", nodeIds: ["weekly_scheduler"] },
    ]);
  });
});

describe("repointWiringText", () => {
  test("rewrites one node's block and leaves the rest of the document byte-identical", () => {
    const out = repointWiringText(
      HALLWAY_LIGHTS_WIRING,
      ["settle"],
      "settle_debounce",
    );
    expect(out).toBe(
      HALLWAY_LIGHTS_WIRING.replace(
        '"block": "debounce"',
        '"block": "settle_debounce"',
      ),
    );
  });

  test("rewrites several nodes in one file, preserving each one's config and every wire", () => {
    const out = repointWiringText(
      HALLWAY_LIGHTS_WIRING,
      ["motion", "lights"],
      "hass_shim",
    );
    const parsed = JSON.parse(out);
    const original = JSON.parse(HALLWAY_LIGHTS_WIRING);
    expect(parsed.nodes.motion.block).toBe("hass_shim");
    expect(parsed.nodes.lights.block).toBe("hass_shim");
    expect(parsed.nodes.motion.config).toEqual(original.nodes.motion.config);
    expect(parsed.nodes.settle).toEqual(original.nodes.settle);
    expect(parsed.nodes.decide).toEqual(original.nodes.decide);
    // The cascade must never disturb wiring — that's the entire bug it fixes.
    expect(parsed.wires).toEqual(original.wires);
  });

  test("an empty node list is a no-op", () => {
    expect(repointWiringText(HALLWAY_LIGHTS_WIRING, [], "whatever")).toBe(
      HALLWAY_LIGHTS_WIRING,
    );
  });
});
