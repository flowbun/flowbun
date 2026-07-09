import { parsePortRef, type Wiring } from "flowbun/wiring";

/**
 * Every port on `nodeId`'s given side (source outputs / target inputs)
 * that's already used by at least one existing wire — used to guess which
 * port a freshly-drawn wire (dropped onto a node's single shared connection
 * point, not a specific port) most likely means.
 */
export function usedPortsForNode(
  wiring: Wiring,
  nodeId: string,
  side: "source" | "target",
): Set<string> {
  const used = new Set<string>();
  for (const [from, to] of wiring.wires) {
    const ref = parsePortRef(side === "source" ? from : to);
    if (ref.nodeId === nodeId) used.add(ref.port);
  }
  return used;
}

/**
 * The first port not already spoken for, falling back to the block's first
 * port if every one of them is already used by some other wire — a block
 * with only one port never needs the fallback.
 */
export function pickDefaultPort(
  ports: string[],
  used: Set<string>,
): string | undefined {
  return ports.find((p) => !used.has(p)) ?? ports[0];
}
