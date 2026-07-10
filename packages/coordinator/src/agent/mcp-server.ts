import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WiringMutationSchema } from "./schemas";
import {
  type AgentToolDeps,
  blockCreateHandler,
  blockDeleteHandler,
  blockReadHandler,
  blockWriteHandler,
  flowCreateHandler,
  flowDeleteHandler,
  flowReadHandler,
  hassEntitiesHandler,
  listBlocksHandler,
  listFlowsHandler,
  type ToolResult,
  wiringMutateHandler,
} from "./tools";

function toCallToolResult(result: ToolResult): CallToolResult {
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
 * Bundles tools.ts's handlers as Claude Agent SDK tools, all under one MCP
 * server named "flowbun" — tool names the model sees are
 * `mcp__flowbun__<name>`. runner.ts passes `tools: []` (disabling every
 * built-in SDK tool — Bash, Read, Write, Edit, WebSearch, etc.) alongside
 * `allowedTools: ["mcp__flowbun__*"]`, so this server is the agent's
 * *entire* capability surface — it can only ever do what a tool here
 * explicitly allows, all of which route through the same typecheck-gated,
 * git-committed, undo-tracked path a human edit uses (see tools.ts).
 */
export function createAgentMcpServer(deps: AgentToolDeps) {
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
        async (args) => toCallToolResult(await wiringMutateHandler(deps, args)),
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
        async (args) => toCallToolResult(await blockWriteHandler(deps, args)),
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
        async (args) => toCallToolResult(await blockCreateHandler(deps, args)),
      ),
      tool(
        "block_delete",
        "Delete a block definition file. Fails if any node in any flow still references it.",
        { file: z.string() },
        async (args) => toCallToolResult(await blockDeleteHandler(deps, args)),
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
        async (args) => toCallToolResult(await flowCreateHandler(deps, args)),
      ),
      tool(
        "flow_delete",
        "Delete a flow's wiring file and stop it running.",
        { file: z.string() },
        async (args) => toCallToolResult(await flowDeleteHandler(deps, args)),
      ),
      tool(
        "flow_read",
        "Read a flow's full current wiring (nodes, their config/position, and wires) as JSON.",
        { file: z.string() },
        async (args) => toCallToolResult(await flowReadHandler(deps, args)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "list_flows",
        "List every known flow with a cheap summary (name, node/wire counts, running status). Call flow_read for full detail on one.",
        {},
        async () => toCallToolResult(await listFlowsHandler(deps)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "list_blocks",
        "List every available block type (name, file, input/output port names, default config) that a flow's nodes can use.",
        {},
        async () => toCallToolResult(await listBlocksHandler(deps)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "block_read",
        "Read a block definition's full current TypeScript source.",
        { file: z.string() },
        async (args) => toCallToolResult(await blockReadHandler(deps, args)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "hass_entities",
        "List real Home Assistant entity IDs (with friendly names where known). Use this to find the correct entity id instead of guessing when writing an @hass/trigger or @hass/action config.",
        {},
        async () => toCallToolResult(await hassEntitiesHandler(deps)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
