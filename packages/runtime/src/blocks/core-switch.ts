import { defineBlock } from "../block";
import type { SwitchConfig, SwitchPosition } from "../core/switch";

/**
 * The block definition itself — see hass-trigger.ts's own doc comment on
 * why this lives here, separate from ../core/switch.ts's own type surface.
 *
 * A manual A/B router: Node-RED's "switch" node simplified to the one case
 * that doesn't need a rules editor — forward whatever arrives on `input` to
 * whichever of `a`/`b` is currently selected, with the *canvas itself* as
 * the control (see block.ts's BlockControl doc comment) rather than the
 * side config panel, so flipping it while comparing two branches live is a
 * single click.
 *
 * `input` is `unknown` — a valid input type, same as core-debug.ts's own
 * `msg: unknown` (accept anything, this block never examines it). `a`/`b`
 * are `any`, not `unknown`, and that difference matters: `unknown` fails
 * the moment it's used as an *output* type wired to a concrete downstream
 * input — the generated wire-assertion is `AssertAssignable<Dest, Src>`,
 * and `unknown extends Dest` only holds when Dest is itself unknown/any
 * (verified directly against tsc, not just reasoned about). `any` is the
 * one type assignable both from any upstream output and to any downstream
 * input, matching this block's actual job of forwarding whatever it's
 * handed, unexamined — the same "don't look at msg" contract Node-RED's own
 * switch node has.
 */
export default defineBlock<
  SwitchConfig,
  { input: unknown },
  // biome-ignore lint/suspicious/noExplicitAny: deliberate — see doc comment above
  { a: any; b: any }
>({
  name: "@core/switch",
  config: { selected: "a" satisfies SwitchPosition },
  control: {
    kind: "toggle",
    configKey: "selected",
    values: ["a", "b"] satisfies [SwitchPosition, SwitchPosition],
    labels: ["A", "B"],
  },
  inputs: { input: {} as unknown },
  // biome-ignore lint/suspicious/noExplicitAny: deliberate — see doc comment above
  outputs: { a: {} as any, b: {} as any },
  async process({ input }, ctx) {
    if (input === undefined) return;
    return ctx.config.selected === "b" ? { b: input } : { a: input };
  },
});
