import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "flowbun/ipc";
import { z } from "zod";
import { WiringMutationSchema } from "./schemas";

/** One IPC round-trip to the coordinator, which owns the real flows/undoStack/
 * registry state and runs the actual tool handler (see coordinator's
 * agent/dispatch-tool-call.ts) — this process never touches that state
 * directly. */
export type ToolCaller = (
  tool: string,
  args: unknown,
) => Promise<AgentToolResult>;

function toCallToolResult(result: AgentToolResult): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: result.ok ? result.summary : (result.error ?? result.summary),
      },
    ],
    isError: !result.ok,
  };
}

/**
 * Bundles the same 13 tools the coordinator's agent/tools.ts implements,
 * all under one MCP server named "flowbun" — tool names the model sees are
 * `mcp__flowbun__<name>`. Every tool call is relayed to the coordinator over
 * IPC via `callTool` rather than touching any state directly (this process
 * has none of its own): the coordinator runs the actual handler against its
 * real flows/undoStack/registry, giving every write here the exact same
 * typecheck-gated/git-committed/undo-tracked path a human edit uses.
 *
 * Deliberately built fresh per agent call (see node-agent.ts), never shared
 * across concurrent calls — `McpServer.connect()` throws if the same
 * instance is connected to two transports at once, and concurrent flow-node
 * agent calls are explicitly a goal here.
 */
export function createAgentMcpServer(callTool: ToolCaller) {
  return createSdkMcpServer({
    name: "flowbun",
    version: "1.0.0",
    tools: [
      tool(
        "wiring_mutate",
        'Apply one mutation to an existing flow\'s wiring: add/remove/reconfigure/move/enable/disable a node, or add/remove/rewire a wire between two node ports ("nodeId.port" refs). The flow must already exist — use flow_create first for a brand-new flow.',
        {
          file: z
            .string()
            .describe('Wiring filename, e.g. "hallway_lights.json"'),
          mutation: WiringMutationSchema,
        },
        async (args) => toCallToolResult(await callTool("wiring_mutate", args)),
      ),
      tool(
        "block_write",
        "Overwrite a block definition's full TypeScript source. The file must already exist — use block_create first for a brand-new block.",
        {
          file: z.string().describe('Block filename, e.g. "debounce.ts"'),
          source: z
            .string()
            .describe("The full new TypeScript source for the block"),
        },
        async (args) => toCallToolResult(await callTool("block_write", args)),
      ),
      tool(
        "block_create",
        "Create a new block from a minimal pass-through skeleton, ready to be customized with block_write.",
        {
          name: z
            .string()
            .describe(
              "Human-readable name — will be slugified into a filename",
            ),
        },
        async (args) => toCallToolResult(await callTool("block_create", args)),
      ),
      tool(
        "block_delete",
        "Delete a block definition file. Fails if any node in any flow still references it.",
        { file: z.string() },
        async (args) => toCallToolResult(await callTool("block_delete", args)),
      ),
      tool(
        "flow_create",
        "Create a new, empty flow (no nodes or wires yet), ready to be built up with wiring_mutate.",
        {
          name: z
            .string()
            .describe(
              "Human-readable name — will be slugified into a filename",
            ),
        },
        async (args) => toCallToolResult(await callTool("flow_create", args)),
      ),
      tool(
        "flow_delete",
        "Delete a flow's wiring file and stop it running.",
        { file: z.string() },
        async (args) => toCallToolResult(await callTool("flow_delete", args)),
      ),
      tool(
        "flow_read",
        "Read a flow's full current wiring (nodes, their config/position, and wires) as JSON.",
        { file: z.string() },
        async (args) => toCallToolResult(await callTool("flow_read", args)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "list_flows",
        "List every known flow with a cheap summary (name, node/wire counts, running status). Call flow_read for full detail on one.",
        {},
        async () => toCallToolResult(await callTool("list_flows", {})),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "list_blocks",
        "List every available block type (name, file, input/output port names, default config) that a flow's nodes can use.",
        {},
        async () => toCallToolResult(await callTool("list_blocks", {})),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "block_read",
        "Read a block definition's full current TypeScript source.",
        { file: z.string() },
        async (args) => toCallToolResult(await callTool("block_read", args)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "hass_entities",
        "List real Home Assistant entity IDs (with friendly names where known). Use this to find the correct entity id instead of guessing when writing an @hass/trigger or @hass/action config.",
        {},
        async () => toCallToolResult(await callTool("hass_entities", {})),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "hass_get_state",
        "Read one Home Assistant entity's full current state and attributes. Use hass_entities first if unsure of the exact entity id.",
        {
          entity: z.string().describe('Entity id, e.g. "light.kitchen"'),
        },
        async (args) =>
          toCallToolResult(await callTool("hass_get_state", args)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "hass_call_service",
        "Call a Home Assistant service (turn things on/off, set positions/temperatures, run scripts...). If the deployment is in dry-run mode the call is accepted but NOT executed, and the result says so — report that honestly rather than claiming the action happened.",
        {
          domain: z.string().describe('Service domain, e.g. "light"'),
          service: z.string().describe('Service name, e.g. "turn_on"'),
          entity_id: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe("Target entity id(s)"),
          data: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Extra service data, e.g. {"brightness_pct": 40} — never put entity_id here',
            ),
        },
        async (args) =>
          toCallToolResult(await callTool("hass_call_service", args)),
      ),
    ],
  });
}
