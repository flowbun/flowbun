import type { Logger, StateScope } from "../block";
import type { ActionCall } from "../hass/action";
import { performHassAction } from "../hass/action";
import { isDryRun, readEntityState } from "../hass/client";
import { listExposedEntities } from "../hass/exposed-entities";
import type { AgentOutputs } from "./agent";
import { splitAgentInput } from "./agent";
import { cancelTimer, startTimer, timerStatus } from "./voice-timers";

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
}

/** Per-call context the block's process() threads through — the tool
 * executor needs this flow's own state scope (timers live there) and the
 * originating satellite's device id (stamped onto each timer so the
 * watchdog announces through the speaker that set it). */
export interface OpenAiAgentHooks {
  flowState?: StateScope;
  deviceId?: string;
}

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

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function callTimerTool(
  name: string,
  args: Record<string, unknown>,
  hooks: OpenAiAgentHooks,
): Promise<string> {
  const state = hooks.flowState;
  if (!state) {
    return JSON.stringify({
      error:
        "timer tools need flow state, which this block wasn't given — this is a wiring/config bug, tell the user timers are unavailable",
    });
  }
  switch (name) {
    case "start_timer": {
      const result = await startTimer(state, {
        hours: asOptionalNumber(args.hours),
        minutes: asOptionalNumber(args.minutes),
        seconds: asOptionalNumber(args.seconds),
        name: asOptionalString(args.name),
        deviceId: hooks.deviceId,
      });
      return JSON.stringify(result);
    }
    case "cancel_timer": {
      const result = await cancelTimer(state, {
        id: asOptionalNumber(args.id),
        name: asOptionalString(args.name),
      });
      return JSON.stringify(result);
    }
    case "timer_status": {
      const result = await timerStatus(state, {
        id: asOptionalNumber(args.id),
        name: asOptionalString(args.name),
      });
      return JSON.stringify(result);
    }
    default:
      return JSON.stringify({ error: `unknown timer tool "${name}"` });
  }
}

const TIMER_TOOL_NAMES = new Set([
  "start_timer",
  "cancel_timer",
  "timer_status",
]);

/** One dispatch for every tool call the loop encounters: parse the
 * arguments once, then route by name — timer tools first (guarded by their
 * own flag), everything else to the HA executor. A tool the model invents,
 * or one whose feature flag is off, resolves as a tool-level error message
 * the model can recover from, never a thrown exception. */
async function executeTool(
  name: string,
  argsJson: string,
  config: OpenAiAgentConfig,
  hooks: OpenAiAgentHooks,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return JSON.stringify({ error: "tool arguments were not valid JSON" });
  }
  if (TIMER_TOOL_NAMES.has(name)) {
    if (!config.enableTimerTools) {
      return JSON.stringify({ error: `unknown tool "${name}"` });
    }
    return callTimerTool(name, args, hooks);
  }
  if (!config.enableHassTools) {
    return JSON.stringify({ error: `unknown tool "${name}"` });
  }
  return callHassTool(name, args);
}

async function callHassTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "hass_get_state": {
      const entity = args.entity;
      if (typeof entity !== "string" || !entity) {
        return JSON.stringify({ error: 'missing required "entity"' });
      }
      const reading = await readEntityState(entity);
      return reading
        ? JSON.stringify(reading)
        : JSON.stringify({ error: `unknown entity "${entity}"` });
    }
    case "hass_call_service": {
      const domain = args.domain;
      const service = args.service;
      if (
        typeof domain !== "string" ||
        typeof service !== "string" ||
        !domain ||
        !service
      ) {
        return JSON.stringify({ error: 'missing required "domain"/"service"' });
      }
      const call: ActionCall = {
        domain,
        service,
        ...(typeof args.entity_id === "string"
          ? { target: { entity_id: args.entity_id } }
          : {}),
        ...(args.data && typeof args.data === "object"
          ? { data: args.data as Record<string, unknown> }
          : {}),
      };
      const dryRun = isDryRun();
      try {
        await performHassAction(call, dryRun);
        return JSON.stringify({ ok: true, dryRun });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    }
    case "hass_list_entities": {
      const entities = await listExposedEntities("conversation");
      return JSON.stringify(entities);
    }
    default:
      return JSON.stringify({ error: `unknown tool "${name}"` });
  }
}

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
      const json = (await res.json()) as ChatCompletionResponse;
      const message = json.choices?.[0]?.message;
      if (!message) {
        throw new Error(
          `@ai/openai_agent: ${endpoint} returned no choices in its response`,
        );
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
        const result = await executeTool(
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
