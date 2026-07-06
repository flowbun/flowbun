// block02: numeric value + timestamp block
export interface Inputs {
  in1: { value: number; at: number };
}
export interface Outputs {
  out1: { value: number; at: number };
}
export async function process(inputs: Inputs): Promise<Outputs> {
  return { out1: { value: inputs.in1.value, at: inputs.in1.at } };
}
