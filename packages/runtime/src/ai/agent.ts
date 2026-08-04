// The block definition itself lives in blocks/ai-agent.ts (see its own doc
// comment) — this file is just the type/config surface.
export interface AgentConfig {
  systemPrompt: string;
  /** "" means "no override" — SDK default model. */
  model: string;
  fullAccess: boolean;
  maxTurns: number;
  timeoutMs: number;
  /** Keep one warm Claude session alive across calls to this node instead
   * of booting a fresh one per call — saves the SDK's fixed startup cost
   * (~3-4s: CLI boot, MCP handshake, system-prompt processing), which is
   * most of the latency of a short voice-assistant turn. The trade: a
   * persistent session is ONE running conversation — every call shares its
   * accumulated history until it's recycled (on config change, error,
   * flow restart, a turn budget, or an idle timeout — see ai-host's
   * node-agent.ts). Leave off for nodes whose calls must not see each
   * other. */
  persistSession: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_FULL_ACCESS_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_FULL_ACCESS_MAX_TURNS = 25;

/**
 * @ai/agent-hass's config (see blocks/agent-hass.ts) — @ai/agent narrowed
 * to the same capability surface as @ai/openai_agent: no fullAccess, no
 * flowbun flow/block-editing tools, just the exposure-respecting HA tools
 * and kitchen-timer tools behind the same two flags @ai/openai_agent uses
 * (executed by the exact same shared code — see hass-tools.ts). The model
 * also gets `systemPrompt` VERBATIM as its whole system prompt — no Claude
 * Code preset preamble — matching how @ai/openai_agent prompts its server.
 * Field-for-field, this is OpenAiAgentConfig minus the wire-format fields
 * (baseUrl/apiKey/maxTokens/temperature/extraBody) plus @ai/agent's
 * model/persistSession, so a node can swap between the three agent blocks
 * by editing only those.
 */
export interface AgentHassConfig {
  systemPrompt: string;
  /** "" means "no override" — SDK default model. */
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** Same warm-session trade as AgentConfig.persistSession above. */
  persistSession: boolean;
  enableHassTools: boolean;
  enableTimerTools: boolean;
}

/** Which tool surface an agent.call relay wants — "full" is @ai/agent
 * (flowbun MCP toolset, claude_code preset prompt), "hass" is
 * @ai/agent-hass (see AgentHassConfig above). Rides the agent.call IPC
 * messages so the ai-host builds the right session; absent means "full"
 * for compatibility. */
export type AgentCallKind = "full" | "hass";
export type AnyAgentConfig = AgentConfig | AgentHassConfig;

/**
 * @ai/agent-hass's outputs: AgentOutputs plus `delta` — pieces of the
 * answer text streamed WHILE the model is still generating, each stamped
 * with the same `meta` echo the final result carries (so a downstream
 * block can correlate chunks to e.g. an @http/in requestId). The final
 * `result` still fires with the complete text after the last delta;
 * deltas are additive, never a replacement. A flow that doesn't wire
 * `delta` behaves exactly as before.
 */
export type AgentHassOutputs = AgentOutputs & {
  delta: { text: string; meta?: unknown };
};

export interface AgentOutputs {
  result: {
    text: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
    /** Echo of the input payload's own `meta` field, when the input was an
     * object carrying one — never shown to the model itself (see
     * DistributedExecutor.callAgent, which strips it before relaying).
     * This is how correlation state (e.g. @http/in's requestId, a voice
     * conversation id) survives the agent hop: the agent's output ports
     * are otherwise a fixed shape that would drop it. */
    meta?: unknown;
  };
}

/**
 * The input-side convention backing `result.meta` above, applied by
 * DistributedExecutor.callAgent before anything reaches the ai-host:
 * - input not an object, or object without a `meta` key → sent verbatim.
 * - object with `meta` → `meta` is held back locally and echoed on
 *   result.meta; the REST of the object is what's sent.
 * - the special two-key shape `{ prompt, meta }` → just `prompt`'s value is
 *   sent, so a plain-string prompt reaches the model as a plain string
 *   instead of one wrapped in a one-key JSON object.
 */
export function splitAgentInput(input: unknown): {
  forwarded: unknown;
  meta: unknown;
} {
  if (typeof input !== "object" || input === null || !("meta" in input)) {
    return { forwarded: input, meta: undefined };
  }
  const { meta, ...rest } = input as Record<string, unknown>;
  const restKeys = Object.keys(rest);
  const forwarded =
    restKeys.length === 1 && restKeys[0] === "prompt" ? rest.prompt : rest;
  return { forwarded, meta };
}
