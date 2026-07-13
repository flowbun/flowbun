import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentToolResult } from "flowbun/ipc";
import type { ChatEvent } from "flowbun/ws";
import { createAgentRunner } from "./runner";
import { readSessionId } from "./session-store";

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

/** Writes a fake SDK transcript at <claudeConfigDir>/projects/<any>/<id>.jsonl — the on-disk shape session-store.ts's listSessions/findSessionTranscriptPath glob for. */
function writeFakeTranscript(
  claudeConfigDir: string,
  sessionId: string,
  userText: string,
): void {
  const projectDir = join(claudeConfigDir, "projects", "-app-data");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    jsonl([
      {
        type: "user",
        promptId: "p1",
        timestamp: "2026-07-09T17:48:41.865Z",
        message: { role: "user", content: [{ type: "text", text: userText }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "reply" }] },
      },
    ]),
  );
}

const UUID = "11111111-1111-1111-1111-111111111111";

function initMessage(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    claude_code_version: "1.0.0",
    cwd: "/app/data",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: UUID,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function resultSuccess(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: UUID,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

let dir: string;
let authedDir: string;
let unauthedDir: string;
let sessionFile: string;
let events: ChatEvent[];
let busyHistory: boolean[];
let onEvent: (event: ChatEvent) => void;
let onBusyChange: (busy: boolean) => void;
const noopCallTool = async (): Promise<AgentToolResult> => ({
  ok: false,
  summary: "not exercised in this test",
});

let savedOauthToken: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  // These tests assert behavior purely from the presence/absence of
  // .credentials.json — clear any ambient auth env vars (e.g. from a
  // developer's own .env, which Bun auto-loads) so they can't mask it.
  savedOauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  savedApiKey = Bun.env.ANTHROPIC_API_KEY;
  delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete Bun.env.ANTHROPIC_API_KEY;

  dir = mkdtempSync(join(tmpdir(), "flowbun-runner-test-"));
  authedDir = join(dir, "authed");
  unauthedDir = join(dir, "unauthed");
  mkdirSync(authedDir);
  mkdirSync(unauthedDir);
  writeFileSync(join(authedDir, ".credentials.json"), "{}");
  sessionFile = join(dir, "session.json");

  events = [];
  busyHistory = [];
  onEvent = (e) => events.push(e);
  onBusyChange = (b) => busyHistory.push(b);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedOauthToken === undefined) delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
  else Bun.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
  if (savedApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
  else Bun.env.ANTHROPIC_API_KEY = savedApiKey;
});

describe("createAgentRunner", () => {
  test("short-circuits with a not_authenticated error when no credentials file exists, without ever calling queryFn", async () => {
    let called = false;
    const fakeQuery = (() => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: unauthedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("hello", "turn-1");

    expect(called).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "turn.error",
      turnId: "turn-1",
      reason: "not_authenticated",
    });
  });

  test("busy flag is true synchronously once sendMessage starts, false again after it settles", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    async function* slowGen() {
      yield initMessage("session-x");
      await gate;
      yield resultSuccess("session-x");
    }
    const fakeQuery = (() => slowGen()) as unknown as typeof query;
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );

    expect(runner.isBusy()).toBe(false);
    const promise = runner.sendMessage("hi", "turn-1");
    expect(runner.isBusy()).toBe(true);
    resolveGate();
    await promise;
    expect(runner.isBusy()).toBe(false);
    expect(busyHistory).toEqual([true, false]);
  });

  test("a second call while busy is rejected immediately with its own turn.error, without invoking queryFn again", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    let callCount = 0;
    async function* slowGen() {
      callCount++;
      yield initMessage("session-x");
      await gate;
      yield resultSuccess("session-x");
    }
    const fakeQuery = (() => slowGen()) as unknown as typeof query;
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );

    const first = runner.sendMessage("hi", "turn-1");
    await runner.sendMessage("hi again", "turn-2");
    expect(callCount).toBe(1);
    const turn2Events = events.filter((e) => e.turnId === "turn-2");
    expect(turn2Events).toHaveLength(1);
    expect(turn2Events[0]).toMatchObject({
      kind: "turn.error",
      reason: "other",
    });

    resolveGate();
    await first;
  });

  test("persists the session id as soon as system/init is seen, even if the stream later throws", async () => {
    async function* gen() {
      yield initMessage("session-abc");
      throw new Error("stream exploded");
    }
    const fakeQuery = (() => gen()) as unknown as typeof query;
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );

    await runner.sendMessage("hi", "turn-1");

    expect(readSessionId(sessionFile)).toBe("session-abc");
    expect(
      events.some((e) => e.kind === "turn.error" && e.reason === "other"),
    ).toBe(true);
  });

  test("maxTurns defaults to 10 and is threaded into query options", async () => {
    const calls: Array<{ options?: { maxTurns?: number } }> = [];
    const fakeQuery = ((params: { options?: { maxTurns?: number } }) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("s1");
        yield resultSuccess("s1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("hi", "turn-1");
    expect(calls[0]?.options?.maxTurns).toBe(10);
  });

  test("an explicit maxTurns override is threaded through instead of the default", async () => {
    const calls: Array<{ options?: { maxTurns?: number } }> = [];
    const fakeQuery = ((params: { options?: { maxTurns?: number } }) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("s1");
        yield resultSuccess("s1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir, maxTurns: 3 },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("hi", "turn-1");
    expect(calls[0]?.options?.maxTurns).toBe(3);
  });

  test("resume is threaded from the persisted session id on a subsequent call, and absent on the first", async () => {
    const calls: Array<{ options?: { resume?: string } }> = [];
    const fakeQuery = ((params: { options?: { resume?: string } }) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("session-1");
        yield resultSuccess("session-1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("first", "turn-1");
    expect(calls[0]?.options?.resume).toBeUndefined();

    await runner.sendMessage("second", "turn-2");
    expect(calls[1]?.options?.resume).toBe("session-1");
  });

  test("currentFlow, when given, is folded into this turn's system prompt append", async () => {
    const calls: Array<{
      options?: { systemPrompt?: { append?: string } };
    }> = [];
    const fakeQuery = ((params: (typeof calls)[number]) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("s1");
        yield resultSuccess("s1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );

    await runner.sendMessage("hi", "turn-1");
    expect(calls[0]?.options?.systemPrompt?.append).not.toContain(
      "currently has the flow file",
    );

    await runner.sendMessage("hi again", "turn-2", "hallway_lights.json");
    expect(calls[1]?.options?.systemPrompt?.append).toContain(
      '"hallway_lights.json"',
    );
  });

  test("disables every built-in tool and allows only the flowbun MCP server", async () => {
    const calls: Array<{
      options?: {
        tools?: unknown;
        allowedTools?: string[];
        mcpServers?: Record<string, unknown>;
      };
    }> = [];
    const fakeQuery = ((params: (typeof calls)[number]) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("s1");
        yield resultSuccess("s1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("hi", "turn-1");
    expect(calls[0]?.options?.tools).toEqual([]);
    expect(calls[0]?.options?.allowedTools).toEqual(["mcp__flowbun__*"]);
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual([
      "flowbun",
    ]);
  });

  test("happy path pushes turn.started, translated stream events, in order", async () => {
    const fakeQuery = (() => {
      async function* gen() {
        yield initMessage("s1");
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Sure thing." }] },
          parent_tool_use_id: null,
          uuid: UUID,
          session_id: "s1",
        } as unknown as SDKMessage;
        yield resultSuccess("s1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("hi", "turn-1");

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["turn.started", "assistant.text", "turn.done"]);
  });

  test("listSessions surfaces transcripts found under claudeConfigDir/projects", () => {
    writeFakeTranscript(authedDir, "session-a", "hello there");
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
    );
    const sessions = runner.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "session-a",
      title: "hello there",
    });
  });

  test("startNewSession clears the current-session pointer so the next call omits resume", async () => {
    const calls: Array<{ options?: { resume?: string } }> = [];
    const fakeQuery = ((params: { options?: { resume?: string } }) => {
      calls.push(params);
      async function* gen() {
        yield initMessage("session-1");
        yield resultSuccess("session-1");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );
    await runner.sendMessage("first", "turn-1");
    expect(readSessionId(sessionFile)).toBe("session-1");

    const result = runner.startNewSession();
    expect(result.ok).toBe(true);
    expect(readSessionId(sessionFile)).toBeUndefined();

    await runner.sendMessage("second", "turn-2");
    expect(calls[1]?.options?.resume).toBeUndefined();
  });

  test("startNewSession rejects while busy", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    async function* slowGen() {
      yield initMessage("session-x");
      await gate;
      yield resultSuccess("session-x");
    }
    const fakeQuery = (() => slowGen()) as unknown as typeof query;
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
      fakeQuery,
    );

    const promise = runner.sendMessage("hi", "turn-1");
    const result = runner.startNewSession();
    expect(result.ok).toBe(false);

    resolveGate();
    await promise;
  });

  test("resumeSession points the pointer at the chosen session and replays its transcript", () => {
    writeFakeTranscript(authedDir, "session-b", "what flows exist?");
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
    );

    const result = runner.resumeSession("session-b");
    expect(result.ok).toBe(true);
    expect(result.events?.map((e) => e.kind)).toEqual([
      "user.text",
      "assistant.text",
      "turn.done",
    ]);
    expect(readSessionId(sessionFile)).toBe("session-b");
  });

  test("resumeSession fails cleanly for an unknown session id", () => {
    const runner = createAgentRunner(
      { claudeConfigDir: authedDir, sessionFile, cwd: dir },
      noopCallTool,
      onEvent,
      onBusyChange,
    );
    const result = runner.resumeSession("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
