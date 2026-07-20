// The block definition itself lives in blocks/core-inject.ts (see its own
// doc comment) — this file is just the type surface.
export interface InjectConfig {
  /** Optional custom button label/tooltip shown in the editor; falls back to "Fire" when empty. */
  label: string;
}

export interface InjectOutputs {
  fired: { at: number };
}
