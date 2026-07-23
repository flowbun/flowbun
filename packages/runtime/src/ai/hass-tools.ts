import type { StateScope } from "../block";
import type { ActionCall } from "../hass/action";
import { performHassAction } from "../hass/action";
import { isDryRun, readEntityState } from "../hass/client";
import { listExposedEntities } from "../hass/exposed-entities";
import { cancelTimer, startTimer, timerStatus } from "./voice-timers";

/**
 * The one shared executor behind every "LLM voice brain" tool surface —
 * @ai/openai_agent's function-calling loop (openai-agent.ts) and
 * @ai/agent-hass's MCP server (ai-host's hass-mcp-server.ts) both route
 * every tool invocation through executeHassAgentTool below, so the two
 * blocks cannot drift in what a tool does, only in how the model is asked
 * to call it. Extracted from openai-agent.ts, where all of this originally
 * lived.
 *
 * Every result is a JSON string handed back to the model as the tool's
 * output — errors included (`{"error": ...}`), never a thrown exception, so
 * the model can recover/apologize instead of killing the whole turn.
 */

/** Per-call context threaded through by whichever block is hosting the
 * loop — the timer tools need the owning flow's state scope (timers live
 * there — see voice-timers.ts) and the originating satellite's device id
 * (stamped onto each timer so timer_watchdog announces through the speaker
 * that set it). */
export interface HassAgentHooks {
  flowState?: StateScope;
  deviceId?: string;
}

/** The two capability gates, mirroring @ai/openai_agent's config flags —
 * a tool whose gate is off resolves as an "unknown tool" error the model
 * sees, exactly as if it had invented the name. */
export interface HassAgentToolFlags {
  enableHassTools: boolean;
  enableTimerTools: boolean;
}

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
  hooks: HassAgentHooks,
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

export const TIMER_TOOL_NAMES = new Set([
  "start_timer",
  "cancel_timer",
  "timer_status",
]);

// hass_call_service checks its target against the exposed-entities set (see
// entityBlockedByExposure below) — cached briefly so a burst of calls in one
// agent turn costs one registry round-trip, not one per call.
const EXPOSED_CACHE_TTL_MS = 30_000;
let exposedCache: { at: number; entities: Set<string> } | null = null;

/** Tests only — the cache is module-level state that would otherwise leak
 * one test's fake exposure list into the next. */
export function resetExposedEntitiesCache(): void {
  exposedCache = null;
}

// listExposedEntities never rejects, but reaching it without an installed
// transport boots a real HA connection (getHass()) that can stall well past
// what a voice turn tolerates — so the whole check races this budget and
// FAILS OPEN. Blocking every service call because the registry was slow is a
// worse failure for a voice assistant than briefly not enforcing exposure.
const EXPOSURE_CHECK_TIMEOUT_MS = 2_000;

/**
 * True only when the exposed-entities list was definitively fetched,
 * non-empty, and doesn't contain `entityId`. An empty list is
 * indistinguishable from a degraded/failed fetch (listExposedEntities
 * returns [] on any failure — see its own doc comment), so it fails open
 * too: a household with genuinely zero exposed entities has nothing worth
 * protecting behind this check anyway.
 */
async function entityBlockedByExposure(entityId: string): Promise<boolean> {
  try {
    const now = Date.now();
    if (!exposedCache || now - exposedCache.at > EXPOSED_CACHE_TTL_MS) {
      const list = await Promise.race([
        listExposedEntities("conversation"),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), EXPOSURE_CHECK_TIMEOUT_MS),
        ),
      ]);
      if (list === null) return false;
      exposedCache = {
        at: now,
        entities: new Set(list.map((e) => e.entity)),
      };
    }
    if (exposedCache.entities.size === 0) return false;
    return !exposedCache.entities.has(entityId);
  } catch {
    return false;
  }
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
      if (
        typeof args.entity_id === "string" &&
        (await entityBlockedByExposure(args.entity_id))
      ) {
        return JSON.stringify({
          ok: false,
          error: `"${args.entity_id}" is not exposed to this assistant — it can't be controlled from here. It may need enabling under that entity's Voice assistants settings in Home Assistant.`,
        });
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

/** One dispatch for every tool call an agent loop encounters: parse the
 * arguments once, then route by name — timer tools first (guarded by their
 * own flag), everything else to the HA executor. A tool the model invents,
 * or one whose feature flag is off, resolves as a tool-level error message
 * the model can recover from, never a thrown exception. */
export async function executeHassAgentTool(
  name: string,
  argsJson: string,
  flags: HassAgentToolFlags,
  hooks: HassAgentHooks,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return JSON.stringify({ error: "tool arguments were not valid JSON" });
  }
  if (TIMER_TOOL_NAMES.has(name)) {
    if (!flags.enableTimerTools) {
      return JSON.stringify({ error: `unknown tool "${name}"` });
    }
    return callTimerTool(name, args, hooks);
  }
  if (!flags.enableHassTools) {
    return JSON.stringify({ error: `unknown tool "${name}"` });
  }
  return callHassTool(name, args);
}
