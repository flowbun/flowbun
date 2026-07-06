// block25: flagged-value block
export interface Inputs {
  in1: { flag: boolean; value: number };
}
export interface Outputs {
  out1: { flag: boolean; value: number };
}
export async function process(inputs: Inputs): Promise<Outputs> {
  return { out1: { flag: !inputs.in1.flag, value: inputs.in1.value } };
}
