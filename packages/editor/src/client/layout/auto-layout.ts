import type { Wiring } from "flowbun/wiring";

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 120;

/**
 * BFS longest-path layering: sources (no incoming wire) at column 0, each
 * wire pushes its target at least one column to the right. Deliberately not
 * dagre/elkjs — flows in this repo top out at ~4 nodes, and this reads
 * left-to-right in signal order with no new dependency. Swap for a real
 * layout library later if flows grow complex enough to need one.
 */
export function autoLayout(
  wiring: Wiring,
): Record<string, { x: number; y: number }> {
  const ids = Object.keys(wiring.nodes);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const [from, to] of wiring.wires) {
    const src = from.split(".")[0];
    const dst = to.split(".")[0];
    if (!src || !dst) continue;
    adj.get(src)?.push(dst);
    indeg.set(dst, (indeg.get(dst) ?? 0) + 1);
  }

  const depth = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, 0);

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const next of adj.get(id) ?? []) {
      const candidate = (depth.get(id) ?? 0) + 1;
      if (candidate > (depth.get(next) ?? -1)) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }
  // Isolated or cyclic-fallback nodes that never got visited.
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const col = depth.get(id) ?? 0;
    columns.set(col, [...(columns.get(col) ?? []), id]);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [col, colIds] of columns) {
    colIds.forEach((id, row) => {
      positions[id] = { x: col * COLUMN_WIDTH, y: row * ROW_HEIGHT };
    });
  }
  return positions;
}
