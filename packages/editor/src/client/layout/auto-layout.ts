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

  // Longest-path relaxation only terminates on a DAG: in an acyclic graph, no
  // node needs relaxing more than |V|-1 times before every value is final. A
  // wire cycle (this codebase has at least one on purpose — e.g. an
  // @http/in-based flow's own reject-shortcut wire routes back to the same
  // node that started the request) has no well-defined longest path at all,
  // so without a bound this simply never converges: a source reachable from
  // outside the cycle keeps pumping ever-larger depth values around it,
  // forever. That's not a hypothetical — deleting one wire in a real,
  // already-deployed flow (dropping a node's indegree to zero right next to
  // an existing cycle) hung the whole editor tab solid, since this runs
  // synchronously on every wiring update (see useFlowGraph.ts). Capping
  // total relaxations at ids.length^2 (a safe upper bound for any graph that
  // WOULD converge) guarantees termination regardless of topology; whatever
  // hasn't settled by then falls through to the isolated/cyclic-fallback
  // pass below. Layout is cosmetic only, so an imperfect column for a node
  // caught in a cycle is a fine trade for "never hangs the tab."
  const maxRelaxations = ids.length * ids.length;
  let relaxations = 0;
  while (queue.length > 0 && relaxations < maxRelaxations) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const next of adj.get(id) ?? []) {
      relaxations++;
      const candidate = (depth.get(id) ?? 0) + 1;
      if (candidate > (depth.get(next) ?? -1)) {
        depth.set(next, candidate);
        queue.push(next);
      }
      if (relaxations >= maxRelaxations) break;
    }
  }
  // Isolated, never-visited, or cycle-abandoned-mid-relaxation nodes.
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
