import type { WiringMutation } from "flowbun/ws";
import { z } from "zod";

/**
 * Hand-authored zod mirror of WiringMutation (flowbun/ws's protocol.ts has
 * no zod version of its own — it's a plain TS discriminated union used only
 * for WS message typing). This is what lets the agent's `wiring_mutate`
 * tool validate/describe its input schema to the model.
 *
 * Maintenance risk: this can silently drift from WiringMutation if a new
 * `op` is added there without a matching case here. The two type-level
 * assertions below make that a compile error, not a silent gap — if they
 * ever fail to typecheck, a case was added/changed on one side but not the
 * other.
 */
const WiringPositionSchema = z.object({ x: z.number(), y: z.number() });

export const WiringMutationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("node.add"),
    nodeId: z.string(),
    block: z.string(),
    config: z.unknown().optional(),
    position: WiringPositionSchema,
  }),
  z.object({ op: z.literal("node.remove"), nodeId: z.string() }),
  z.object({
    op: z.literal("node.config"),
    nodeId: z.string(),
    config: z.unknown(),
  }),
  z.object({
    op: z.literal("node.block"),
    nodeId: z.string(),
    block: z.string(),
  }),
  z.object({
    op: z.literal("node.position"),
    nodeId: z.string(),
    position: WiringPositionSchema,
  }),
  z.object({
    op: z.literal("node.disabled"),
    nodeId: z.string(),
    disabled: z.boolean(),
  }),
  z.object({
    op: z.literal("flow.disabled"),
    disabled: z.boolean(),
  }),
  z.object({
    op: z.literal("node.rename"),
    nodeId: z.string(),
    newNodeId: z.string(),
  }),
  z.object({ op: z.literal("wire.add"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("wire.remove"), from: z.string(), to: z.string() }),
  z.object({
    op: z.literal("wire.rewire"),
    from: z.string(),
    to: z.string(),
    newFrom: z.string(),
    newTo: z.string(),
  }),
]);

type SchemaShape = z.infer<typeof WiringMutationSchema>;
// Both directions must hold: every real WiringMutation must satisfy the
// schema's inferred shape, and vice versa — a one-way check would miss a
// schema case that's stricter/looser than the real type on either side.
type _AssertSchemaAcceptsRealType = WiringMutation extends SchemaShape
  ? true
  : never;
type _AssertRealTypeAcceptsSchema = SchemaShape extends WiringMutation
  ? true
  : never;
const _typeAssertions: [
  _AssertSchemaAcceptsRealType,
  _AssertRealTypeAcceptsSchema,
] = [true, true];
