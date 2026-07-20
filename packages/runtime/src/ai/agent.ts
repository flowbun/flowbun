// The block definition itself lives in blocks/ai-agent.ts (see its own doc
// comment) — this file is just the type/config surface.
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
