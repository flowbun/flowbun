import { describe, expect, test } from "bun:test";
import type { Wiring } from "flowbun/wiring";
import { pickDefaultPort, usedPortsForNode } from "./pickWirePort";

function wiring(wires: [string, string][]): Wiring {
  return { name: "test", nodes: {}, wires };
}

describe("usedPortsForNode", () => {
  test("collects only the ports actually used by the given node on the given side", () => {
    const w = wiring([
      ["a.chargeOn", "b.call"],
      ["a.chargeOff", "c.call"],
      ["d.out", "a.other_input"],
    ]);
    expect(usedPortsForNode(w, "a", "source")).toEqual(
      new Set(["chargeOn", "chargeOff"]),
    );
    expect(usedPortsForNode(w, "a", "target")).toEqual(
      new Set(["other_input"]),
    );
  });

  test("a node with no wires on that side has no used ports", () => {
    const w = wiring([["a.out", "b.in"]]);
    expect(usedPortsForNode(w, "b", "source")).toEqual(new Set());
  });
});

describe("pickDefaultPort", () => {
  test("picks the first port not already used", () => {
    const used = new Set(["chargeOn", "chargeOff"]);
    expect(
      pickDefaultPort(
        ["chargeOn", "chargeOff", "dischargeOn", "dischargeOff"],
        used,
      ),
    ).toBe("dischargeOn");
  });

  test("falls back to the first port when every port is already used", () => {
    const used = new Set(["a", "b"]);
    expect(pickDefaultPort(["a", "b"], used)).toBe("a");
  });

  test("a block with a single port always picks it, used or not", () => {
    expect(pickDefaultPort(["only"], new Set())).toBe("only");
    expect(pickDefaultPort(["only"], new Set(["only"]))).toBe("only");
  });

  test("a block with no ports returns undefined", () => {
    expect(pickDefaultPort([], new Set())).toBeUndefined();
  });
});
