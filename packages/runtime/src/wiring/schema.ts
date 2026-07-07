import { z } from "zod";

// This module is deliberately browser-safe (only depends on zod, no Bun/Node
// builtins) and exposed as its own "flowbun/wiring" subpath for exactly that
// reason: the editor's client bundle needs Wiring/parsePortRef/WiringSchema,
// but importing anything from the main "flowbun" barrel (index.ts) pulls in
// bun:sqlite, @digital-alchemy/hass, and their Node-only transitive deps
// (child_process, etc.), which fails to bundle for a browser target at all.

const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT_REF_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;

const PositionSchema = z.object({ x: z.number(), y: z.number() });

const WiringNodeSchema = z.object({
  block: z.string().min(1),
  config: z.unknown().optional(),
  // Editor-only (canvas layout) — never reaches LoadedNode/assembleFlow,
  // meaningless at runtime. Optional so every existing committed wiring
  // file stays valid without being touched.
  position: PositionSchema.optional(),
});

const PortRefSchema = z
  .string()
  .regex(PORT_REF_RE, 'expected "<nodeId>.<port>"');
const WireSchema = z.tuple([PortRefSchema, PortRefSchema]);

export const WiringSchema = z
  .object({
    name: z.string().min(1),
    nodes: z.record(z.string().regex(NODE_ID_RE), WiringNodeSchema),
    wires: z.array(WireSchema),
  })
  .superRefine((flow, ctx) => {
    flow.wires.forEach((wire, idx) => {
      for (const side of [0, 1] as const) {
        const ref = wire[side];
        const nodeId = ref.split(".")[0] as string;
        if (!(nodeId in flow.nodes)) {
          ctx.addIssue({
            code: "custom",
            message: `references unknown node "${nodeId}"`,
            path: ["wires", idx, side],
          });
        }
      }
    });
  });

export type Wiring = z.infer<typeof WiringSchema>;

export function parsePortRef(ref: string): { nodeId: string; port: string } {
  const match = PORT_REF_RE.exec(ref);
  if (!match) throw new Error(`invalid port ref "${ref}"`);
  return { nodeId: match[1] as string, port: match[2] as string };
}
