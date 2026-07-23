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
