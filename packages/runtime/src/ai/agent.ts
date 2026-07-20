import { defineBlock } from "../block";

export interface AgentConfig {
  systemPrompt: string;
  /** "" means "no override" — SDK default model. */
  model: string;
  fullAccess: boolean;
  maxTurns: number;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_FULL_ACCESS_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_FULL_ACCESS_MAX_TURNS = 25;

export interface AgentOutputs {
  result: {
    text: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
  };
}

export default defineBlock<AgentConfig, { prompt: unknown }, AgentOutputs>({
  name: "@ai/agent",
  // Driven by normal wire delivery on "prompt" like a transform, but never
  // actually calls process() — this node's real work is relayed to the
  // coordinator (and onward to the dedicated ai-host process) over IPC;
  // DistributedExecutor recognizes `kind: "relay"` and dispatches there
  // instead. See RelayBlockDef's own doc comment in block.ts.
  kind: "relay",
  config: {
    systemPrompt: "",
    model: "",
    fullAccess: false,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
  inputs: { prompt: {} as unknown },
  outputs: { result: {} as AgentOutputs["result"] },
});
