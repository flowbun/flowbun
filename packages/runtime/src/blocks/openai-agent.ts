import type { AgentOutputs } from "../ai/agent";
import type { OpenAiAgentConfig } from "../ai/openai-agent";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  runOpenAiAgent,
} from "../ai/openai-agent";
import { defineBlock } from "../block";

/**
 * The block definition itself — see hass-trigger.ts's own doc comment on
 * why this lives here, separate from ../ai/openai-agent.ts's real logic.
 *
 * Deliberately an ordinary block (no `kind` — the default "transform"),
 * unlike @ai/agent's `kind: "relay"`: this doesn't need the coordinator or
 * the dedicated ai-host process, since it holds no Claude credentials and
 * needs no Agent SDK session — it's a plain HTTP call running in its own
 * persistent Worker like any other node. Same `prompt` input and
 * AgentOutputs result shape as @ai/agent, so it's a genuine drop-in swap
 * in any flow already wired against @ai/agent.
 */
export default defineBlock<
  OpenAiAgentConfig,
  { prompt: unknown },
  AgentOutputs
>({
  name: "@ai/openai_agent",
  config: {
    baseUrl: "",
    model: "",
    apiKey: "",
    systemPrompt: "",
    maxTurns: DEFAULT_MAX_TURNS,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    enableHassTools: false,
    enableTimerTools: false,
  },
  inputs: { prompt: {} as unknown },
  outputs: { result: {} as AgentOutputs["result"] },
  async process({ prompt }, ctx) {
    const result = await runOpenAiAgent(ctx.config, prompt, ctx.log, {
      // Timers are per-flow shared state — the same scope voice_gate reads
      // to show them in the prompt and timer_watchdog polls for expiry.
      flowState: ctx.state.flow,
    });
    return { result };
  },
});
