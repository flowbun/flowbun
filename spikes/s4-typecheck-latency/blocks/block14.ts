// block14: nested-object value-with-metadata block
export interface Inputs {
  in1: { value: number; meta: { unit: string } };
}
export interface Outputs {
  out1: { value: number; meta: { unit: string } };
}
export async function process(inputs: Inputs): Promise<Outputs> {
  return { out1: { value: inputs.in1.value * 2, meta: inputs.in1.meta } };
}
