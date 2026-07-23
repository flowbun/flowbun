import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HassAgentHooks, HassAgentToolFlags } from "flowbun/ai/hass-tools";
import { executeHassAgentTool } from "flowbun/ai/hass-tools";
import { z } from "zod";

/**
 * The @ai/agent-hass toolset — tool-for-tool and schema-for-schema the same
 * surface @ai/openai_agent offers its server (HASS_TOOLS/TIMER_TOOLS in
 * runtime's openai-agent.ts), just expressed as an in-process MCP server
 * for the Claude Agent SDK instead of OpenAI function-calling JSON. Every
 * invocation executes through the SAME shared executor
 * (flowbun/ai/hass-tools's executeHassAgentTool) the openai block uses, so
 * the two blocks cannot drift behaviorally.
 *
 * Unlike mcp-server.ts's "flowbun" server (the full 13-tool set relayed to
 * the coordinator over IPC), everything here runs directly in this ai-host
 * process against its own lazily-booted HA connection (getHass() reads the
 * same HASS_BASE_URL/HASS_TOKEN env every flow-host uses) and the shared
 * SQLite state DB (timers) — no coordinator round-trip, mirroring how the
 * openai block's tools run directly in its own Worker.
 *
 * `hooks` is a mutable ref, not a value: a persistSession node keeps ONE
 * server alive across many calls (see node-agent.ts's HotSession), but the
 * originating satellite's deviceId changes per call — each call updates
 * `hooks.current` before pushing its prompt, and the closures below always
 * read through the ref at invocation time.
 */
export interface MutableHassHooks {
  current: HassAgentHooks;
}

function run(
  name: string,
  args: unknown,
  flags: HassAgentToolFlags,
  hooks: MutableHassHooks,
) {
  return executeHassAgentTool(
    name,
    JSON.stringify(args ?? {}),
    flags,
    hooks.current,
  ).then((text) => {
    // The executor reports failures as data (`{"error": ...}` /
    // `{"ok": false, ...}`), never a throw — surface that as MCP's isError
    // so the model gets the same "this tool call failed" signal an OpenAI
    // tool-role error message gives.
    let isError = false;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; ok?: unknown };
      isError = Boolean(parsed?.error) || parsed?.ok === false;
    } catch {
      // Non-JSON output is a successful payload by definition.
    }
    return { content: [{ type: "text" as const, text }], isError };
  });
}

export function createHassAgentMcpServer(
  flags: HassAgentToolFlags,
  hooks: MutableHassHooks,
) {
  const hassTools = [
    tool(
      "hass_get_state",
      "Read one Home Assistant entity's current state and attributes.",
      { entity: z.string().describe('Entity id, e.g. "light.kitchen"') },
      (args) => run("hass_get_state", args, flags, hooks),
    ),
    tool(
      "hass_call_service",
      "Call a Home Assistant service to control a device (turn on/off, open/close, set values...).",
      {
        domain: z.string().describe('Service domain, e.g. "light"'),
        service: z.string().describe('Service name, e.g. "turn_on"'),
        entity_id: z.string().optional().describe("Target entity id"),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extra service data"),
      },
      (args) => run("hass_call_service", args, flags, hooks),
    ),
    tool(
      "hass_list_entities",
      "List entities this assistant is allowed to see/control (Home Assistant's Voice assistants exposure setting) — use this to find the correct entity id instead of guessing.",
      {},
      (args) => run("hass_list_entities", args, flags, hooks),
    ),
  ];
  const timerTools = [
    tool(
      "start_timer",
      "Start a kitchen timer. It gets an auto-assigned number (and optionally a name); when it finishes, the speaker announces it automatically.",
      {
        hours: z.number().optional().describe("Hours component"),
        minutes: z.number().optional().describe("Minutes component"),
        seconds: z.number().optional().describe("Seconds component"),
        name: z
          .string()
          .optional()
          .describe('Optional spoken label, e.g. "pasta"'),
      },
      (args) => run("start_timer", args, flags, hooks),
    ),
    tool(
      "cancel_timer",
      "Cancel a running timer by its number or name. With neither, cancels the only running timer (errors if several are running).",
      {
        id: z.number().optional().describe("Timer number"),
        name: z.string().optional().describe("Timer name"),
      },
      (args) => run("cancel_timer", args, flags, hooks),
    ),
    tool(
      "timer_status",
      "How much time is left. With no arguments, reports every running timer; narrow with a number or name.",
      {
        id: z.number().optional().describe("Timer number"),
        name: z.string().optional().describe("Timer name"),
      },
      (args) => run("timer_status", args, flags, hooks),
    ),
  ];
  return createSdkMcpServer({
    name: "hass",
    version: "1.0.0",
    // Mirrors the openai block: a flagged-off tool simply isn't offered
    // (and the shared executor independently refuses it even if called).
    tools: [
      ...(flags.enableHassTools ? hassTools : []),
      ...(flags.enableTimerTools ? timerTools : []),
    ],
  });
}
