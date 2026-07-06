// block09: string payload block
export interface Inputs {
  in1: { text: string; at: number };
}
export interface Outputs {
  out1: { text: string; at: number };
}
export async function process(inputs: Inputs): Promise<Outputs> {
  return { out1: { text: inputs.in1.text.trim(), at: inputs.in1.at } };
}
