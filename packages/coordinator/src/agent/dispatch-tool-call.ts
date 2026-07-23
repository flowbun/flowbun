import {
  type AgentToolDeps,
  blockCreateHandler,
  blockDeleteHandler,
  blockReadHandler,
  blockWriteHandler,
  flowCreateHandler,
  flowDeleteHandler,
  flowReadHandler,
  hassCallServiceHandler,
  hassEntitiesHandler,
  hassGetStateHandler,
  listBlocksHandler,
  listFlowsHandler,
  type ToolResult,
  wiringMutateHandler,
} from "./tools";

/**
 * Runs one MCP tool call relayed from the ai-host process over IPC ("tool.call"
 * — see ai-host-client.ts) against this coordinator's real, live state — the
 * same handlers tools.ts always exposed, just invoked by name instead of
 * wired directly into an in-process MCP server. Every write still goes
 * through the exact same typecheck-gated/git-committed/undo-tracked path a
 * human edit uses.
 */
export async function dispatchToolCall(
  deps: AgentToolDeps,
  tool: string,
  args: unknown,
): Promise<ToolResult> {
  switch (tool) {
    case "wiring_mutate":
      return wiringMutateHandler(
        deps,
        args as Parameters<typeof wiringMutateHandler>[1],
      );
    case "block_write":
      return blockWriteHandler(
        deps,
        args as Parameters<typeof blockWriteHandler>[1],
      );
    case "block_create":
      return blockCreateHandler(
        deps,
        args as Parameters<typeof blockCreateHandler>[1],
      );
    case "block_delete":
      return blockDeleteHandler(
        deps,
        args as Parameters<typeof blockDeleteHandler>[1],
      );
    case "flow_create":
      return flowCreateHandler(
        deps,
        args as Parameters<typeof flowCreateHandler>[1],
      );
    case "flow_delete":
      return flowDeleteHandler(
        deps,
        args as Parameters<typeof flowDeleteHandler>[1],
      );
    case "flow_read":
      return flowReadHandler(
        deps,
        args as Parameters<typeof flowReadHandler>[1],
      );
    case "list_flows":
      return listFlowsHandler(deps);
    case "list_blocks":
      return listBlocksHandler(deps);
    case "block_read":
      return blockReadHandler(
        deps,
        args as Parameters<typeof blockReadHandler>[1],
      );
    case "hass_entities":
      return hassEntitiesHandler(deps);
    case "hass_get_state":
      return hassGetStateHandler(
        deps,
        args as Parameters<typeof hassGetStateHandler>[1],
      );
    case "hass_call_service":
      return hassCallServiceHandler(
        deps,
        args as Parameters<typeof hassCallServiceHandler>[1],
      );
    default:
      return {
        ok: false,
        summary: `Unknown tool "${tool}"`,
        error: `unknown tool "${tool}"`,
      };
  }
}
