import type { Logger } from "../block";
import type { AgentOutputs } from "./agent";
import { splitAgentInput } from "./agent";
import type { HassAgentHooks } from "./hass-tools";
import { executeHassAgentTool } from "./hass-tools";

/**
 * @ai/openai_agent's config — a deliberate drop-in for @ai/agent's own
 * AgentConfig (same `prompt` input, same AgentOutputs result shape, same
 * `{prompt, meta}`/splitAgentInput convention — see blocks/openai-agent.ts),
 * but talking to any server that speaks OpenAI's `/chat/completions` wire
 * format instead of the Claude Agent SDK: llama.cpp's `llama-server`,
 * Ollama's OpenAI-compatible endpoint, vLLM, LM Studio, text-generation-webui,
 * or a real OpenAI-compatible cloud endpoint.
 *
 * Architecturally this block needs none of @ai/agent's machinery — no
 * Claude credentials, no coordinator relay, no dedicated ai-host process.
 * It's a plain HTTP call (plus an optional small tool-calling loop against
 * this flow's own HA connection, entirely self-contained — see
 * runOpenAiAgent below), so it runs as an ORDINARY node in its own
 * persistent Worker, exactly like @hass/action or a user block such as
 * battery_controller.
 */
export interface OpenAiAgentConfig {
  /**
   * Base URL of an OpenAI-chat-completions-compatible server, INCLUDING
   * any version path segment it expects — e.g. "http://192.168.1.100:8080/v1"
   * for llama.cpp's `llama-server` (its default port is 8080; start it
   * with `llama-server`, not `llama-bench` — the latter is a one-shot
   * benchmark that exits, not a server), or "http://host:11434/v1" for
   * Ollama. "" (the default) is deliberately unconfigured — the block
   * throws immediately rather than silently doing nothing.
   */
  baseUrl: string;
  /**
   * Sent verbatim as the request body's "model" field — required by the
   * OpenAI schema, but most single-model local servers (llama.cpp's
   * llama-server, LM Studio) ignore its value and just serve whatever
   * model they were started with.
   */
  model: string;
  /** "" omits the Authorization header entirely — most local servers
   * (including llama.cpp's default) don't require one at all. */
  apiKey: string;
  systemPrompt: string;
  /** Bounds the tool-calling loop below — 1 means "answer straight from
   * the first completion, no tool call is ever actually followed even if
   * the model attempts one." */
  maxTurns: number;
  maxTokens: number;
  temperature: number;
  /**
   * Whole-call budget, all turns combined. Also becomes this node's own
   * WorkerManager exec-timeout override (see distributed-executor.ts's
   * WORKER_TIMEOUT_MARGIN_MS doc comment) — set generously for a slow
   * local model rather than tightly; the block itself is what actually
   * enforces this via its own AbortController.
   */
  timeoutMs: number;
  /**
   * SECURITY, off by default. When true, the model is offered
   * hass_get_state/hass_call_service/hass_list_entities function-calling
   * tools that act for real on this flow's own Home Assistant connection
   * (hass_call_service respects FLOWBUN_DRY_RUN exactly like @hass/action
   * does). Unlike @ai/agent's Claude path, there is no requirement that
   * `baseUrl` even be authenticated — an API-key-less OpenAI-compatible
   * endpoint is completely normal for a local server — so whatever can
   * reach that URL (and influence what it returns) effectively controls
   * this. Only enable this against a server and network path you actually
   * trust; leave it off to run this purely as a chat/comparison block
   * with no ability to touch real devices.
   */
  enableHassTools: boolean;
  /**
   * Offers start_timer/cancel_timer/timer_status function-calling tools
   * backed by flowbun/ai/voice-timers (flow-scope state — see that module's
   * own doc comment). Setting a timer only STORES it; something else in the
   * flow must watch for expiry and announce it (the voice-assist package's
   * timer_watchdog block). Separate flag from enableHassTools because the
   * trust calculus differs: timer tools can't touch any real device — worst
   * case is a spurious announcement — so it's reasonable to enable them
   * against a server you wouldn't yet trust with hass_call_service.
   */
  enableTimerTools: boolean;
  /**
   * Extra properties merged verbatim into every /chat/completions request
   * body, after the standard fields (so a key here overrides them; `tools`
   * is the one exception — the tool-calling loop owns it). The escape
   * hatch for server-specific knobs this config doesn't model — e.g.
   * llama.cpp's `{"chat_template_kwargs": {"enable_thinking": false}}` to
   * stop a thinking-by-default model (Qwen3+) from spending its whole
   * token budget on reasoning, or `top_p`/`min_p` sampling overrides.
   */
  extraBody: Record<string, unknown>;
  /**
   * Requests server-sent-events streaming (`"stream": true`) from the
   * server and emits answer text out the block's `delta` port as it
   * generates — the same delta contract @ai/agent-hass streams (see
   * AgentHassOutputs in agent.ts), so a flow wired for one streams from
   * either. Off by default: the non-streamed path is the lowest common
   * denominator every OpenAI-compatible server handles, while streamed
   * TOOL CALLS specifically need a server that reassembles them properly
   * (llama.cpp does, verified against its incremental tool_calls deltas;
   * enable against anything else only after checking).
   */
  stream: boolean;
}

/** Per-call context the block's process() threads through — the shared
 * hooks (see HassAgentHooks in hass-tools.ts, where the tool executor and
 * its documentation live) plus this block's own streaming callback. */
export type OpenAiAgentHooks = HassAgentHooks & {
  /** Streamed pieces of the answer text, called zero or more times before
   * runOpenAiAgent resolves — only when config.stream is on. `meta` is the
   * same held-back input echo the final result carries, re-attached so the
   * block can stamp it onto each delta for downstream correlation. Pieces
   * are time-batched (DELTA_FLUSH_MS) like @ai/agent-hass's, so a fast
   * server doesn't become a message per token. */
  onDelta?: (text: string, meta: unknown) => void;
};

export const DEFAULT_MAX_TURNS = 4;
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_TIMEOUT_MS = 30_000;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content: string | null; tool_calls?: ToolCall[] };
  }>;
}

/** One `data:` line's delta in a streamed response (chat.completion.chunk).
 * tool_calls arrive incrementally: the first fragment for an `index`
 * carries id/name plus the opening arguments piece, later fragments append
 * to `arguments` — consumeSseTurn below reassembles by index (the format
 * llama.cpp's llama-server was verified to emit; also OpenAI's own). */
interface StreamedDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

// Streamed answer pieces flush to onDelta at most once per this interval —
// mirrors ai-host's DEFAULT_DELTA_FLUSH_MS reasoning: each flush becomes a
// Worker event plus a router fan-out, and a fast server's per-token events
// would otherwise become one message each.
const DELTA_FLUSH_MS = 120;

function makeDeltaBatcher(
  onDelta: (text: string) => void,
  flushMs = DELTA_FLUSH_MS,
): { push: (text: string) => void; flush: () => void } {
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf) {
      const text = buf;
      buf = "";
      onDelta(text);
    }
  };
  return {
    push: (text) => {
      buf += text;
      timer ??= setTimeout(flush, flushMs);
    },
    flush,
  };
}

/**
 * Reads one streamed completion (SSE `data:` lines ending in `[DONE]`) into
 * the same `{content, tool_calls}` message shape the non-streamed path gets
 * from the response JSON — the tool loop downstream is identical either
 * way. Answer text (`delta.content`) is ALSO pushed to `emitDelta` as it
 * arrives; reasoning deltas (a thinking model with thinking left on) are
 * deliberately not — they were never part of the spoken answer.
 */
async function consumeSseTurn(
  res: Response,
  endpoint: string,
  emitDelta: ((text: string) => void) | null,
): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  if (!res.body) {
    throw new Error(`@ai/openai_agent: ${endpoint} streamed no response body`);
  }
  let content = "";
  let sawContent = false;
  const toolCalls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let delta: StreamedDelta | undefined;
        try {
          delta = (
            JSON.parse(payload) as {
              choices?: Array<{ delta?: StreamedDelta }>;
            }
          ).choices?.[0]?.delta;
        } catch {
          continue; // tolerate a torn/garbled event, keep reading
        }
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content !== "") {
          sawContent = true;
          content += delta.content;
          emitDelta?.(delta.content);
        }
        for (const fragment of delta.tool_calls ?? []) {
          const index = fragment.index ?? 0;
          let call = toolCalls[index];
          if (!call) {
            call = {
              id: fragment.id ?? `call_${index}`,
              type: "function",
              function: { name: fragment.function?.name ?? "", arguments: "" },
            };
            toolCalls[index] = call;
          }
          if (fragment.id) call.id = fragment.id;
          if (fragment.function?.name)
            call.function.name = fragment.function.name;
          if (fragment.function?.arguments) {
            call.function.arguments += fragment.function.arguments;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    // null (not "") when no content delta ever arrived — matching what a
    // non-streamed pure-tool-call response reports.
    content: sawContent ? content : null,
    ...(toolCalls.length > 0
      ? { tool_calls: toolCalls.filter((c) => c !== undefined) }
      : {}),
  };
}

/** OpenAI function-calling tool schemas for the three HA capabilities this
 * block exposes — deliberately the exposed-entities set, not "every entity
 * in the house" (see hass_list_entities below), matching the same
 * exposure-respecting design the voice-assist package's entity_directory
 * block applies on the Claude side. */
const HASS_TOOLS = [
  {
    type: "function",
    function: {
      name: "hass_get_state",
      description:
        "Read one Home Assistant entity's current state and attributes.",
      parameters: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: 'Entity id, e.g. "light.kitchen"',
          },
        },
        required: ["entity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hass_call_service",
      description:
        "Call a Home Assistant service to control a device (turn on/off, open/close, set values...).",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: 'Service domain, e.g. "light"',
          },
          service: {
            type: "string",
            description: 'Service name, e.g. "turn_on"',
          },
          entity_id: { type: "string", description: "Target entity id" },
          data: { type: "object", description: "Extra service data" },
        },
        required: ["domain", "service"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hass_list_entities",
      description:
        "List entities this assistant is allowed to see/control (Home Assistant's Voice assistants exposure setting) — use this to find the correct entity id instead of guessing.",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

/** Kitchen-timer tools, offered when enableTimerTools is set (and the block
 * passed a flow state scope to keep them in). Descriptions tell the model
 * the store handles ordinals/names itself, so it doesn't invent ids. */
const TIMER_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_timer",
      description:
        "Start a kitchen timer. It gets an auto-assigned number (and optionally a name); when it finishes, the speaker announces it automatically.",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Hours component" },
          minutes: { type: "number", description: "Minutes component" },
          seconds: { type: "number", description: "Seconds component" },
          name: {
            type: "string",
            description: 'Optional spoken label, e.g. "pasta"',
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_timer",
      description:
        "Cancel a running timer by its number or name. With neither, cancels the only running timer (errors if several are running).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Timer number" },
          name: { type: "string", description: "Timer name" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "timer_status",
      description:
        "How much time is left. With no arguments, reports every running timer; narrow with a number or name.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Timer number" },
          name: { type: "string", description: "Timer name" },
        },
      },
    },
  },
] as const;

/**
 * The real work: a small, self-contained OpenAI chat-completions client
 * with an optional tool-calling loop — no dependency on the coordinator or
 * ai-host, since none of this needs Claude credentials or the Agent SDK.
 * Mirrors @ai/agent's own input/output contract exactly (splitAgentInput's
 * `{prompt, meta}` convention, AgentOutputs' result shape, costUsd always 0
 * since this is self-hosted) so the two blocks are wire-compatible.
 *
 * Throws on any real failure (unconfigured baseUrl, network error,
 * non-2xx, timeout) rather than returning a synthetic error result — same
 * failure semantics as @ai/agent's own relay path, so swapping between the
 * two doesn't change how a wired-up flow (e.g. voice_assist_demo) reacts to
 * a failure.
 */
export async function runOpenAiAgent(
  config: OpenAiAgentConfig,
  input: unknown,
  log: Logger,
  hooks: OpenAiAgentHooks = {},
): Promise<AgentOutputs["result"]> {
  if (!config.baseUrl) {
    throw new Error(
      '@ai/openai_agent: "baseUrl" is not configured (e.g. "http://192.168.1.100:8080/v1" for a llama.cpp llama-server)',
    );
  }

  const { forwarded, meta } = splitAgentInput(input);
  // The originating satellite's device id rides in on the meta (voice_gate
  // stamps it there) — surface it to the tool executor so a started timer
  // knows which speaker to announce through, unless the caller already
  // provided one explicitly.
  const metaDeviceId =
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as { deviceId?: unknown }).deviceId === "string"
      ? ((meta as { deviceId: string }).deviceId as string)
      : undefined;
  const toolHooks: OpenAiAgentHooks = {
    ...hooks,
    deviceId: hooks.deviceId ?? metaDeviceId,
  };
  const promptText =
    typeof forwarded === "string"
      ? forwarded
      : JSON.stringify(forwarded ?? null);

  const messages: ChatMessage[] = [];
  if (config.systemPrompt)
    messages.push({ role: "system", content: config.systemPrompt });
  messages.push({ role: "user", content: promptText });

  const maxTurns = config.maxTurns || DEFAULT_MAX_TURNS;
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const start = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    config.timeoutMs || DEFAULT_TIMEOUT_MS,
  );

  const onDelta = hooks.onDelta;
  const batcher =
    config.stream && onDelta
      ? makeDeltaBatcher((text) => onDelta(text, meta))
      : null;

  try {
    let finalText = "";
    let numTurns = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      numTurns++;
      const tools = [
        ...(config.enableHassTools ? HASS_TOOLS : []),
        ...(config.enableTimerTools ? TIMER_TOOLS : []),
      ];
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        ...config.extraBody,
        ...(config.stream ? { stream: true } : {}),
      };
      if (tools.length > 0) body.tools = tools;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey
            ? { authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      if (!res.ok) {
        throw new Error(
          `@ai/openai_agent: ${endpoint} responded ${res.status}: ${await res.text()}`,
        );
      }
      let message: { content: string | null; tool_calls?: ToolCall[] };
      if (config.stream) {
        message = await consumeSseTurn(
          res,
          endpoint,
          batcher ? batcher.push : null,
        );
      } else {
        const json = (await res.json()) as ChatCompletionResponse;
        const parsed = json.choices?.[0]?.message;
        if (!parsed) {
          throw new Error(
            `@ai/openai_agent: ${endpoint} returned no choices in its response`,
          );
        }
        message = parsed;
      }

      const toolCalls = tools.length > 0 ? message.tool_calls : undefined;
      if (!toolCalls || toolCalls.length === 0) {
        finalText = message.content ?? "";
        break;
      }

      log.info("openai_agent.tool_calls", {
        turn,
        tools: toolCalls.map((c) => c.function.name),
      });
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        const result = await executeHassAgentTool(
          call.function.name,
          call.function.arguments,
          config,
          toolHooks,
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (turn === maxTurns - 1) {
        // Ran out of turns while the model was still mid-tool-call — no
        // further completion request will happen, so surface whatever text
        // it produced alongside its last tool call rather than nothing.
        finalText = message.content || "(ran out of turns while using tools)";
      }
    }

    batcher?.flush();
    return {
      text: finalText,
      costUsd: 0,
      durationMs: Date.now() - start,
      numTurns,
      ...(meta === undefined ? {} : { meta }),
    };
  } finally {
    clearTimeout(timer);
  }
}
