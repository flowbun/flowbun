import type { Wiring } from "flowbun/wiring";

let nextIdSuffix = 1;

export function freshNodeId(blockName: string, wiring: Wiring): string {
  const base = blockName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "");
  let id = base;
  while (id in wiring.nodes || id === "") {
    id = `${base}_${nextIdSuffix++}`;
  }
  return id;
}
