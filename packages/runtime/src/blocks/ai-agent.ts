import type { AgentConfig, AgentOutputs } from "../ai/agent";
import { DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS } from "../ai/agent";
import { defineBlock } from "../block";

/** The block definition itself — see hass-trigger.ts's own doc comment on why this lives here, separate from ../ai/agent.ts's own type exports. */
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
