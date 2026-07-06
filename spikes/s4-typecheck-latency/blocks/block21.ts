// block21: numeric array block
export interface Inputs {
  in1: { items: number[] };
}
export interface Outputs {
  out1: { items: number[] };
}
export async function process(inputs: Inputs): Promise<Outputs> {
  return { out1: { items: inputs.in1.items.slice().reverse() } };
}
