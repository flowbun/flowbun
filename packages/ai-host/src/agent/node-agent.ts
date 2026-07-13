import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "flowbun/ai/agent";
import {
  DEFAULT_FULL_ACCESS_MAX_TURNS,
  DEFAULT_FULL_ACCESS_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
} from "flowbun/ai/agent";
import { hasClaudeCredentials } from "./auth";
import { createAgentMcpServer, type ToolCaller } from "./mcp-server";

export type AgentCallResult =
  | {
      ok: true;
      text: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { ok: false; error: string };

export interface AgentNodeCaller {
  call(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AgentConfig,
  ): Promise<AgentCallResult>;
  /** Aborts every in-flight call belonging to `flowName` — called when that
   * flow's flow-host is about to be killed for a restart/stop, so a call
   * whose result nobody will ever receive doesn't keep running (and
   * costing real API tokens) in the background. */
  cancelForFlow(flowName: string): void;
}

export interface AgentNodeCallerOptions {
  claudeConfigDir: string;
  /** Pinned cwd for every query() call — see runner.ts's own note on why
   * this must stay stable. */
  cwd: string;
}

type QueryFn = typeof query;

function promptFromInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? null);
}

/**
 * Owns every flow node's @ai/agent calls. Deliberately independent of
 * runner.ts's chat AgentRunner: no shared session, no shared busy flag, no
 * `resume` — every call is a fresh, ephemeral session, so flow-node calls
 * run concurrently with each other and with an interactive chat turn
 * instead of queuing behind one global flag.
 */
export function createAgentNodeCaller(
  opts: AgentNodeCallerOptions,
  callTool: ToolCaller,
  queryFn: QueryFn = query,
): AgentNodeCaller {
  const controllersByFlow = new Map<string, Set<AbortController>>();

  function track(flowName: string, controller: AbortController): () => void {
    let set = controllersByFlow.get(flowName);
    if (!set) {
      set = new Set();
      controllersByFlow.set(flowName, set);
    }
    set.add(controller);
    return () => {
      set?.delete(controller);
      if (set?.size === 0) controllersByFlow.delete(flowName);
    };
  }

  function cancelForFlow(flowName: string): void {
    const set = controllersByFlow.get(flowName);
    if (!set) return;
    for (const controller of set) controller.abort();
    controllersByFlow.delete(flowName);
  }

  async function call(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AgentConfig,
  ): Promise<AgentCallResult> {
    if (!hasClaudeCredentials(opts.claudeConfigDir)) {
      return {
        ok: false,
        error:
          "Claude isn't set up yet. Run once: ./scripts/setup-claude-auth.sh",
      };
    }

    const timeoutMs =
      config.timeoutMs ||
      (config.fullAccess ? DEFAULT_FULL_ACCESS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const maxTurns =
      config.maxTurns ||
      (config.fullAccess ? DEFAULT_FULL_ACCESS_MAX_TURNS : DEFAULT_MAX_TURNS);

    // Fresh per call, never shared — see mcp-server.ts's own comment on why
    // a shared instance would throw on the second concurrent call.
    const mcpServer = createAgentMcpServer(callTool);
    const abortController = new AbortController();
    const untrack = track(flowName, abortController);

    try {
      const stream = queryFn({
        prompt: promptFromInput(input),
        options: {
          cwd: opts.cwd,
          model: config.model || undefined,
          maxTurns,
          abortController,
          // Bounded mode still gets the flowbun MCP tools (same scope as
          // the interactive chat agent) — only fullAccess additionally
          // inherits the SDK's full built-in tool set (Bash/Read/Write/
          // Edit/WebFetch/WebSearch/...) by omitting `tools` entirely.
          ...(config.fullAccess ? {} : { tools: [] }),
          mcpServers: { flowbun: mcpServer },
          allowedTools: ["mcp__flowbun__*"],
          ...(config.fullAccess
            ? {
                permissionMode: "bypassPermissions" as const,
                allowDangerouslySkipPermissions: true,
              }
            : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: config.systemPrompt,
          },
        },
      });

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          abortController.abort();
          reject(
            new Error(`agent node "${nodeId}" timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      });

      const consume = (async (): Promise<AgentCallResult> => {
        for await (const message of stream) {
          if (message.type === "result") {
            if (message.subtype === "success") {
              return {
                ok: true,
                text: message.result,
                costUsd: message.total_cost_usd,
                durationMs: message.duration_ms,
                numTurns: message.num_turns,
              };
            }
            return {
              ok: false,
              error: message.errors?.join("; ") || message.subtype,
            };
          }
        }
        return { ok: false, error: "agent stream ended without a result" };
      })();
      // If `timeout` wins the race, `consume` is still running in the
      // background against an aborted stream — it will settle (resolve or
      // reject) once the abort propagates, but by then nothing awaits it;
      // this swallows that so it can never surface as an unhandled
      // rejection.
      consume.catch(() => {});

      return await Promise.race([consume, timeout]);
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      untrack();
    }
  }

  return { call, cancelForFlow };
}
