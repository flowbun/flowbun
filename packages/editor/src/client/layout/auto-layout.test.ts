import { describe, expect, test } from "bun:test";
import type { Wiring } from "flowbun/wiring";
import { autoLayout } from "./auto-layout";

function wiring(nodeIds: string[], wires: Array<[string, string]>): Wiring {
  return {
    name: "test",
    nodes: Object.fromEntries(nodeIds.map((id) => [id, { block: "x" }])),
    wires,
  };
}

describe("autoLayout", () => {
  test("a simple chain lays out left to right in signal order", () => {
    const w = wiring(
      ["a", "b", "c"],
      [
        ["a.out", "b.in"],
        ["b.out", "c.in"],
      ],
    );
    const pos = autoLayout(w);
    expect(pos.a?.x).toBeLessThan(pos.b?.x ?? 0);
    expect(pos.b?.x).toBeLessThan(pos.c?.x ?? 0);
  });

  test("an isolated node with no wires at all gets a position", () => {
    const pos = autoLayout(wiring(["lonely"], []));
    expect(pos.lonely).toEqual({ x: 0, y: 0 });
  });

  test("a fully cyclic graph (no node has zero incoming wires) terminates immediately — the loop body never runs", () => {
    // The original, always-present shape in this codebase: an @http/in-style
    // request/reply round trip where every node has at least one incoming
    // wire (a.out->b.in, b.out->a.in). No indegree-0 source exists, so the
    // relaxation queue starts empty and the while loop's body never
    // executes at all — this case was never actually buggy.
    const w = wiring(
      ["a", "b"],
      [
        ["a.out", "b.in"],
        ["b.out", "a.in"],
      ],
    );
    const pos = autoLayout(w);
    expect(pos.a).toBeDefined();
    expect(pos.b).toBeDefined();
  });

  /**
   * Regression test for the real incident: a live flow had an
   * always-present cycle (endpoint -> gate -> endpoint, via a reject-
   * shortcut wire) that was harmless as long as nothing in it had zero
   * incoming wires. Deleting one unrelated wire dropped a downstream node's
   * indegree to zero, making it a BFS "source" whose own output routes back
   * into that cycle — feeding it an ever-increasing depth forever, since a
   * cycle has no well-defined longest path. Because useFlowGraph.ts calls
   * autoLayout() synchronously on every wiring update, this hung the whole
   * browser tab solid (Chrome reported RESULT_CODE_HUNG), not just a slow
   * render. Modeled here at the same shape: `source` (indegree 0) feeds
   * into a 3-node cycle a->b->c->a.
   *
   * The real assertion is that this call RETURNS AT ALL within the test's
   * own timeout — before the fix, this line never returned, hanging the
   * whole bun test process exactly like it hung the browser tab.
   */
  test("a source feeding into a downstream cycle does not hang — terminates and still positions every node", () => {
    const w = wiring(
      ["source", "a", "b", "c"],
      [
        ["source.out", "a.in"],
        ["a.out", "b.in"],
        ["b.out", "c.in"],
        ["c.out", "a.in"], // closes the cycle a -> b -> c -> a
      ],
    );
    const pos = autoLayout(w);
    expect(pos.source).toBeDefined();
    expect(pos.a).toBeDefined();
    expect(pos.b).toBeDefined();
    expect(pos.c).toBeDefined();
    expect(pos.source?.x).toBe(0);
  }, 1000);

  test("a larger cycle with an external entry point also terminates (the exact live-incident shape)", () => {
    // voice_agent(source) -> voice_reply -> voice_endpoint -> voice_gate ->
    // voice_endpoint (reject shortcut) and voice_gate -> voice_agent_local,
    // collapsed to the same node-level shape that actually hung.
    const w = wiring(
      ["endpoint", "gate", "agent", "reply", "agent_local"],
      [
        ["endpoint.request", "gate.request"],
        ["gate.reject", "endpoint.reply"],
        ["reply.reply", "endpoint.reply"],
        ["agent.result", "reply.result"], // agent has NO incoming wire (deleted)
        ["gate.prompt", "agent_local.prompt"],
      ],
    );
    const pos = autoLayout(w);
    expect(Object.keys(pos).sort()).toEqual(
      ["agent", "agent_local", "endpoint", "gate", "reply"].sort(),
    );
  }, 1000);
});
