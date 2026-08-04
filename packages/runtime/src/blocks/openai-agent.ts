import type { AgentHassOutputs } from "../ai/agent";
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
 * `kind: "duplex"` (formerly a plain transform), for the same reason as
 * @http/in: with `stream` on, process() must push `delta` events out
 * mid-flight, and the `emit` handle only subscribe() receives — stashed at
 * module level, one Worker per node so this is per-node state in the real
 * topology — is the only way an ordinary node can do that. The subscribe
 * itself opens nothing and unsubscribing just drops the handle.
 *
 * Unlike @ai/agent's `kind: "relay"`, this still runs entirely in its own
 * persistent Worker — no coordinator, no ai-host, no Claude credentials.
 * Same `prompt` input and result shape as @ai/agent and @ai/agent-hass,
 * and the same `delta` port contract as @ai/agent-hass (AgentHassOutputs),
 * so all three agent blocks are drop-in swaps for each other.
 */
let emitDelta: ((payload: unknown) => void) | null = null;

export default defineBlock<
  OpenAiAgentConfig,
  { prompt: unknown },
  AgentHassOutputs
>({
  name: "@ai/openai_agent",
  kind: "duplex",
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
    extraBody: {},
    stream: false,
  },
  inputs: { prompt: {} as unknown },
  outputs: {
    result: {} as AgentHassOutputs["result"],
    delta: {} as AgentHassOutputs["delta"],
  },
  async subscribe(_ctx, emit) {
    emitDelta = (payload) => emit("delta", payload);
    return () => {
      emitDelta = null;
    };
  },
  async process({ prompt }, ctx) {
    const result = await runOpenAiAgent(ctx.config, prompt, ctx.log, {
      // Timers are per-flow shared state — the same scope voice_gate reads
      // to show them in the prompt and timer_watchdog polls for expiry.
      flowState: ctx.state.flow,
      onDelta: (text, meta) =>
        emitDelta?.({ text, ...(meta === undefined ? {} : { meta }) }),
    });
    return { result };
  },
});
