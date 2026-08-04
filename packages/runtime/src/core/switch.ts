// The block definition itself lives in blocks/core-switch.ts (see its own
// doc comment) — this file is just the type surface.
export type SwitchPosition = "a" | "b";

export interface SwitchConfig {
  selected: SwitchPosition;
}
