import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "flowbun/ai/agent";
import type { AgentToolResult } from "flowbun/ipc";
import { createAgentNodeCaller } from "./node-agent";

const UUID = "22222222-2222-2222-2222-222222222222";

function resultSuccess(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 2,
    result: text,
    stop_reason: null,
    total_cost_usd: 0.05,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: UUID,
    session_id: "s1",
  } as unknown as SDKMessage;
}

function resultError(subtype: string): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: ["hit the turn limit"],
    uuid: UUID,
    session_id: "s1",
  } as unknown as SDKMessage;
}

function fakeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: "be helpful",
    model: "",
    fullAccess: false,
    maxTurns: 6,
    timeoutMs: 30,
    persistSession: false,
    ...overrides,
  };
}

const noopCallTool = async (): Promise<AgentToolResult> => ({
  ok: false,
  summary: "not exercised in this test",
});

let dir: string;
let authedDir: string;
let unauthedDir: string;

let savedOauthToken: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  savedOauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  savedApiKey = Bun.env.ANTHROPIC_API_KEY;
  delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete Bun.env.ANTHROPIC_API_KEY;

  dir = mkdtempSync(join(tmpdir(), "flowbun-node-agent-test-"));
  authedDir = join(dir, "authed");
  unauthedDir = join(dir, "unauthed");
  mkdirSync(authedDir);
  mkdirSync(unauthedDir);
  writeFileSync(join(authedDir, ".credentials.json"), "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedOauthToken === undefined) delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  else Bun.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
  if (savedApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
  else Bun.env.ANTHROPIC_API_KEY = savedApiKey;
});

describe("createAgentNodeCaller", () => {
  test("short-circuits with an error when no credentials exist, without ever calling queryFn", async () => {
    let called = false;
    const fakeQuery = (() => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: unauthedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call("flow1", "n1", "hi", fakeConfig());

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("bounded mode disables built-in tools but keeps the flowbun MCP server", async () => {
    const calls: Array<{
      options?: {
        tools?: unknown;
        mcpServers?: Record<string, unknown>;
        allowedTools?: string[];
        permissionMode?: string;
      };
    }> = [];
    const fakeQuery = ((params: (typeof calls)[number]) => {
      calls.push(params);
      async function* gen() {
        yield resultSuccess("done");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    await caller.call("flow1", "n1", "hi", fakeConfig({ fullAccess: false }));

    expect(calls[0]?.options?.tools).toEqual([]);
    expect(calls[0]?.options?.permissionMode).toBeUndefined();
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual([
      "flowbun",
    ]);
    expect(calls[0]?.options?.allowedTools).toEqual(["mcp__flowbun__*"]);
  });

  test('agentKind "hass" swaps in the hass MCP server, a verbatim systemPrompt, and no flowbun tools', async () => {
    const calls: Array<{
      options?: {
        tools?: unknown;
        mcpServers?: Record<string, unknown>;
        allowedTools?: string[];
        systemPrompt?: unknown;
        permissionMode?: string;
      };
    }> = [];
    const fakeQuery = ((params: (typeof calls)[number]) => {
      calls.push(params);
      async function* gen() {
        yield resultSuccess("done");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call(
      "flow1",
      "n1",
      "hi",
      {
        systemPrompt: "you are a voice assistant",
        model: "",
        maxTurns: 4,
        timeoutMs: 30,
        persistSession: false,
        enableHassTools: true,
        enableTimerTools: true,
      },
      "hass",
      "device-abc",
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.options?.tools).toEqual([]);
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual(["hass"]);
    expect(calls[0]?.options?.allowedTools).toEqual(["mcp__hass__*"]);
    // The whole system prompt, verbatim — no claude_code preset wrapper.
    expect(calls[0]?.options?.systemPrompt).toBe("you are a voice assistant");
    expect(calls[0]?.options?.permissionMode).toBeUndefined();
  });

  test("hass calls stream batched text deltas to onDelta before the result settles", async () => {
    const streamEvent = (text: string) =>
      ({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: UUID,
      }) as unknown as SDKMessage;
    const fakeQuery = (() => {
      async function* gen() {
        yield streamEvent("The coffee ");
        yield streamEvent("machine is ");
        // A tool-use delta must never leak into the answer stream.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
          parent_tool_use_id: null,
        } as unknown as SDKMessage;
        yield streamEvent("off.");
        yield resultSuccess("The coffee machine is off.");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir, deltaFlushMs: 1 },
      noopCallTool,
      fakeQuery,
    );
    const deltas: string[] = [];
    const result = await caller.call(
      "flow1",
      "n1",
      "hi",
      {
        systemPrompt: "voice",
        model: "",
        maxTurns: 4,
        timeoutMs: 5000,
        persistSession: false,
        enableHassTools: true,
        enableTimerTools: false,
      },
      "hass",
      undefined,
      (text) => deltas.push(text),
    );

    expect(result).toEqual({
      ok: true,
      text: "The coffee machine is off.",
      costUsd: 0.05,
      durationMs: 100,
      numTurns: 2,
    });
    // Batching may coalesce pieces, but concatenated they are exactly the
    // spoken text, with the tool-use delta excluded.
    expect(deltas.join("")).toBe("The coffee machine is off.");
    expect(deltas.length).toBeGreaterThan(0);
  });

  test("fullAccess mode omits `tools` (inherits built-ins) and sets bypassPermissions", async () => {
    const calls: Array<{
      options?: {
        tools?: unknown;
        permissionMode?: string;
        allowDangerouslySkipPermissions?: boolean;
      };
    }> = [];
    const fakeQuery = ((params: (typeof calls)[number]) => {
      calls.push(params);
      async function* gen() {
        yield resultSuccess("done");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    await caller.call("flow1", "n1", "hi", fakeConfig({ fullAccess: true }));

    expect(calls[0]?.options?.tools).toBeUndefined();
    expect(calls[0]?.options?.permissionMode).toBe("bypassPermissions");
    expect(calls[0]?.options?.allowDangerouslySkipPermissions).toBe(true);
  });

  test("a non-success result subtype maps to ok:false with the reported errors", async () => {
    const fakeQuery = (() => {
      async function* gen() {
        yield resultError("error_max_turns");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call("flow1", "n1", "hi", fakeConfig());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("hit the turn limit");
  });

  test("a thrown/rejected stream is caught — call() never rejects", async () => {
    const fakeQuery = (() => {
      // biome-ignore lint/correctness/useYield: deliberately throws before any yield
      async function* gen(): AsyncGenerator<SDKMessage> {
        throw new Error("stream exploded");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call("flow1", "n1", "hi", fakeConfig());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("stream exploded");
  });

  test("on the happy path, resolves with the SDK's cost/duration/turn count", async () => {
    const fakeQuery = (() => {
      async function* gen() {
        yield resultSuccess("the answer is 42");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call("flow1", "n1", "hi", fakeConfig());

    expect(result).toEqual({
      ok: true,
      text: "the answer is 42",
      costUsd: 0.05,
      durationMs: 100,
      numTurns: 2,
    });
  });

  test("non-string input is JSON-stringified into the prompt", async () => {
    const prompts: string[] = [];
    const fakeQuery = ((params: { prompt: string }) => {
      prompts.push(params.prompt);
      async function* gen() {
        yield resultSuccess("ok");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    await caller.call(
      "flow1",
      "n1",
      { at: 123, entity: "sun.sun" },
      fakeConfig(),
    );

    expect(prompts[0]).toBe(JSON.stringify({ at: 123, entity: "sun.sun" }));
  });

  test("timeout aborts the underlying AbortController and resolves ok:false, not a hang", async () => {
    let abortedFlag = false;
    const fakeQuery = ((params: {
      options: { abortController: AbortController };
    }) => {
      params.options.abortController.signal.addEventListener("abort", () => {
        abortedFlag = true;
      });
      async function* gen(): AsyncGenerator<SDKMessage> {
        // Never yields — simulates a call that hangs until aborted.
        await new Promise(() => {});
        yield resultSuccess("never reached");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    const result = await caller.call(
      "flow1",
      "n1",
      "hi",
      fakeConfig({ timeoutMs: 15 }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
    expect(abortedFlag).toBe(true);
  });

  test("cancelForFlow aborts only in-flight calls belonging to that flow", async () => {
    const abortedByFlow = new Map<string, boolean>();
    const fakeQuery = ((params: {
      options: { abortController: AbortController };
    }) => {
      const controller = params.options.abortController;
      return (async function* (): AsyncGenerator<SDKMessage> {
        const gate = new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve());
        });
        await gate;
        throw new Error("aborted");
      })();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );

    const flow1Call = caller
      .call("flow1", "n1", "hi", fakeConfig({ timeoutMs: 5000 }))
      .then((r) => {
        abortedByFlow.set("flow1", !r.ok);
      });
    const flow2Call = caller
      .call("flow2", "n2", "hi", fakeConfig({ timeoutMs: 5000 }))
      .then((r) => {
        abortedByFlow.set("flow2", !r.ok);
      });

    // Give both calls a tick to register their AbortControllers before
    // cancelling just flow1.
    await new Promise((r) => setTimeout(r, 5));
    caller.cancelForFlow("flow1");
    await flow1Call;

    expect(abortedByFlow.get("flow1")).toBe(true);
    expect(abortedByFlow.get("flow2")).toBeUndefined();

    caller.cancelForFlow("flow2");
    await flow2Call;
    expect(abortedByFlow.get("flow2")).toBe(true);
  });

  test("two concurrent calls each get their own MCP-server-building call, not a shared instance", async () => {
    const mcpServersSeen: unknown[] = [];
    const fakeQuery = ((params: {
      options: { mcpServers: { flowbun: unknown } };
    }) => {
      mcpServersSeen.push(params.options.mcpServers.flowbun);
      async function* gen() {
        yield resultSuccess("ok");
      }
      return gen();
    }) as unknown as typeof query;

    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      fakeQuery,
    );
    await Promise.all([
      caller.call("flow1", "n1", "hi", fakeConfig()),
      caller.call("flow2", "n2", "hi", fakeConfig()),
    ]);

    expect(mcpServersSeen).toHaveLength(2);
    expect(mcpServersSeen[0]).not.toBe(mcpServersSeen[1]);
  });
});

/**
 * The persistSession (hot session) path: one streaming-input query() kept
 * alive across calls. The fake queryFn here consumes the pushed user
 * messages and answers one result per message — echoing the prompt back so
 * tests can prove which session answered which call.
 */
describe("createAgentNodeCaller persistSession", () => {
  function echoStreamingQuery(queryCalls: unknown[][] = []) {
    return ((params: {
      prompt: AsyncIterable<{ message: { content: string } }>;
      options: { abortController: AbortController };
    }) => {
      queryCalls.push([params]);
      return (async function* (): AsyncGenerator<SDKMessage> {
        for await (const user of params.prompt) {
          const text = user.message.content;
          if (text.includes("HANG")) {
            await new Promise(() => {});
          }
          if (text.includes("FAIL")) {
            yield resultError("error_during_execution");
          } else {
            yield {
              ...(resultSuccess(`echo: ${text}`) as object),
            } as SDKMessage;
          }
        }
      })();
    }) as unknown as typeof query;
  }

  const hotConfig = (overrides: Partial<AgentConfig> = {}) =>
    fakeConfig({ persistSession: true, timeoutMs: 5000, ...overrides });

  test("two calls share one warm query() session, and both get their own answers", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    const first = await caller.call("flow1", "n1", "turn one", hotConfig());
    const second = await caller.call("flow1", "n1", "turn two", hotConfig());

    expect(queryCalls).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, text: "echo: turn one" });
    expect(second).toMatchObject({ ok: true, text: "echo: turn two" });
  });

  test("a config change abandons the old session and boots a fresh one", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    await caller.call("flow1", "n1", "a", hotConfig());
    await caller.call(
      "flow1",
      "n1",
      "b",
      hotConfig({ systemPrompt: "be terse now" }),
    );

    expect(queryCalls).toHaveLength(2);
  });

  test("different nodes never share a session", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    await caller.call("flow1", "n1", "a", hotConfig());
    await caller.call("flow1", "n2", "b", hotConfig());

    expect(queryCalls).toHaveLength(2);
  });

  test("a failed turn recycles the session — the next call gets a fresh one", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    const failed = await caller.call("flow1", "n1", "FAIL now", hotConfig());
    expect(failed.ok).toBe(false);

    const next = await caller.call("flow1", "n1", "recovered?", hotConfig());
    expect(next).toMatchObject({ ok: true, text: "echo: recovered?" });
    expect(queryCalls).toHaveLength(2);
  });

  test("a hot turn that hangs times out, kills the session, and the next call recovers", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    const hung = await caller.call(
      "flow1",
      "n1",
      "HANG please",
      hotConfig({ timeoutMs: 20 }),
    );
    expect(hung.ok).toBe(false);
    if (!hung.ok) expect(hung.error).toContain("timed out");

    const next = await caller.call(
      "flow1",
      "n1",
      "alive again?",
      hotConfig({ timeoutMs: 20 }),
    );
    expect(next).toMatchObject({ ok: true, text: "echo: alive again?" });
    expect(queryCalls).toHaveLength(2);
  });

  test("cancelForFlow tears the hot session down; the next call boots fresh", async () => {
    const queryCalls: unknown[][] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir },
      noopCallTool,
      echoStreamingQuery(queryCalls),
    );

    await caller.call("flow1", "n1", "before restart", hotConfig());
    caller.cancelForFlow("flow1");
    const after = await caller.call(
      "flow1",
      "n1",
      "after restart",
      hotConfig(),
    );

    expect(after).toMatchObject({ ok: true, text: "echo: after restart" });
    expect(queryCalls).toHaveLength(2);
  });
});

/**
 * The stall watchdog: a hung SDK stream (no messages at all) gets its
 * session killed and the call automatically retried once on a fresh one —
 * distinct from the per-turn timeout, which means "the work was too slow"
 * and is deliberately not retried.
 */
describe("createAgentNodeCaller stall watchdog", () => {
  /** Session 1 boots then goes silent forever; every later session echoes.
   * Works for both prompt shapes (string = one-shot, iterable = hot). */
  function hangFirstSessionQuery(queryCalls: unknown[] = []) {
    return ((params: {
      prompt: string | AsyncIterable<{ message: { content: string } }>;
    }) => {
      const sessionIndex = queryCalls.length;
      queryCalls.push(params);
      return (async function* (): AsyncGenerator<SDKMessage> {
        if (typeof params.prompt === "string") {
          if (sessionIndex === 0) await new Promise(() => {});
          yield resultSuccess(`echo: ${params.prompt}`);
          return;
        }
        for await (const user of params.prompt) {
          if (sessionIndex === 0) await new Promise(() => {});
          yield resultSuccess(`echo: ${user.message.content}`);
        }
      })();
    }) as unknown as typeof query;
  }

  test("a stalled hot session is killed and the request retried fresh, answering normally", async () => {
    const queryCalls: unknown[] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir, stallTimeoutMs: 25 },
      noopCallTool,
      hangFirstSessionQuery(queryCalls),
    );

    const result = await caller.call(
      "flow1",
      "n1",
      "hello?",
      fakeConfig({ persistSession: true, timeoutMs: 5000 }),
    );

    expect(result).toMatchObject({ ok: true, text: "echo: hello?" });
    expect(queryCalls).toHaveLength(2);
  });

  test("a stalled one-shot call is also retried once", async () => {
    const queryCalls: unknown[] = [];
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir, stallTimeoutMs: 25 },
      noopCallTool,
      hangFirstSessionQuery(queryCalls),
    );

    const result = await caller.call(
      "flow1",
      "n1",
      "hello?",
      fakeConfig({ timeoutMs: 5000 }),
    );

    expect(result).toMatchObject({ ok: true, text: "echo: hello?" });
    expect(queryCalls).toHaveLength(2);
  });

  test("a permanently-stalled SDK fails after exactly one retry, not an endless loop", async () => {
    const queryCalls: unknown[] = [];
    const alwaysHang = ((params: unknown) => {
      queryCalls.push(params);
      return (async function* (): AsyncGenerator<SDKMessage> {
        await new Promise(() => {});
        yield resultSuccess("never");
      })();
    }) as unknown as typeof query;
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir, stallTimeoutMs: 25 },
      noopCallTool,
      alwaysHang,
    );

    const result = await caller.call(
      "flow1",
      "n1",
      "hello?",
      fakeConfig({ persistSession: true, timeoutMs: 5000 }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("stalled");
    expect(queryCalls).toHaveLength(2);
  });

  test("fullAccess calls never trip the stall watchdog — a hang hits the turn timeout instead", async () => {
    const caller = createAgentNodeCaller(
      { claudeConfigDir: authedDir, cwd: dir, stallTimeoutMs: 10 },
      noopCallTool,
      hangFirstSessionQuery(),
    );

    const result = await caller.call(
      "flow1",
      "n1",
      "hello?",
      fakeConfig({ fullAccess: true, timeoutMs: 60 }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });
});
