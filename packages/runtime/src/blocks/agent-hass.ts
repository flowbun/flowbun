import type { AgentHassConfig, AgentOutputs } from "../ai/agent";
import { DEFAULT_TIMEOUT_MS } from "../ai/agent";
import { DEFAULT_MAX_TURNS as OPENAI_DEFAULT_MAX_TURNS } from "../ai/openai-agent";
import { defineBlock } from "../block";

/**
 * @ai/agent restricted to @ai/openai_agent's capability surface — see
 * AgentHassConfig's own doc comment (ai/agent.ts) for exactly what's
 * narrowed and why. Same `kind: "relay"` dispatch as @ai/agent (the real
 * work happens in the ai-host process, the only place holding Claude
 * credentials); the ai-host tells the two apart by the `agentKind` field
 * DistributedExecutor stamps onto the agent.call from this block's name.
 * Same `prompt` input and AgentOutputs result shape as both other agent
 * blocks, so all three are drop-in swaps for each other in a wired flow.
 *
 * maxTurns deliberately defaults to @ai/openai_agent's 4, not @ai/agent's
 * 6 — this block exists to be that block's like-for-like comparison.
 */
export default defineBlock<AgentHassConfig, { prompt: unknown }, AgentOutputs>({
  name: "@ai/agent-hass",
  kind: "relay",
  config: {
    systemPrompt: "",
    model: "",
    maxTurns: OPENAI_DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    persistSession: false,
    enableHassTools: false,
    enableTimerTools: false,
  },
  inputs: { prompt: {} as unknown },
  outputs: { result: {} as AgentOutputs["result"] },
});
