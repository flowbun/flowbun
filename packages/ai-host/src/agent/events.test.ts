import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { translateSdkMessage } from "./events";

const UUID = "11111111-1111-1111-1111-111111111111";
const TURN = "turn-1";

function assistantMessage(content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    message: { content } as never,
    parent_tool_use_id: null,
    uuid: UUID,
    session_id: "session-1",
  } as SDKMessage;
}

function userMessage(content: unknown[]): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SDKMessage;
}

describe("translateSdkMessage", () => {
  test("assistant text block becomes assistant.text", () => {
    const events = translateSdkMessage(
      assistantMessage([{ type: "text", text: "Hello there" }]),
      TURN,
    );
    expect(events).toEqual([
      { kind: "assistant.text", turnId: TURN, text: "Hello there" },
    ]);
  });

  test("assistant tool_use block becomes tool.started with a readable summary", () => {
    const events = translateSdkMessage(
      assistantMessage([
        {
          type: "tool_use",
          id: "call-1",
          name: "mcp__flowbun__wiring_mutate",
          input: {
            file: "hallway_lights.json",
            mutation: {
              op: "node.position",
              nodeId: "a",
              position: { x: 1, y: 2 },
            },
          },
        },
      ]),
      TURN,
    );
    expect(events).toEqual([
      {
        kind: "tool.started",
        turnId: TURN,
        toolCallId: "call-1",
        summary: "wiring_mutate: node.position in hallway_lights.json",
      },
    ]);
  });

  test("assistant message can emit both a text block and a tool_use block", () => {
    const events = translateSdkMessage(
      assistantMessage([
        { type: "text", text: "Let me check that." },
        {
          type: "tool_use",
          id: "call-2",
          name: "mcp__flowbun__list_flows",
          input: {},
        },
      ]),
      TURN,
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("assistant.text");
    expect(events[1]?.kind).toBe("tool.started");
  });

  test("successful tool_result becomes tool.finished with ok:true", () => {
    const events = translateSdkMessage(
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [{ type: "text", text: "moved node a" }],
        },
      ]),
      TURN,
    );
    expect(events).toEqual([
      {
        kind: "tool.finished",
        turnId: TURN,
        toolCallId: "call-1",
        ok: true,
        summary: "moved node a",
        error: undefined,
      },
    ]);
  });

  test("failed tool_result becomes tool.finished with ok:false and the error text", () => {
    const events = translateSdkMessage(
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "call-1",
          is_error: true,
          content: "unknown wiring file",
        },
      ]),
      TURN,
    );
    expect(events).toEqual([
      {
        kind: "tool.finished",
        turnId: TURN,
        toolCallId: "call-1",
        ok: false,
        summary: undefined,
        error: "unknown wiring file",
      },
    ]);
  });

  test("a plain string user message (no tool results) yields no events", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: "just text" },
      parent_tool_use_id: null,
    } as SDKMessage;
    expect(translateSdkMessage(msg, TURN)).toEqual([]);
  });

  test("a user text block is dropped by default (live streaming never re-echoes the user's own prompt)", () => {
    const events = translateSdkMessage(
      userMessage([{ type: "text", text: "hello" }]),
      TURN,
    );
    expect(events).toEqual([]);
  });

  test("a user text block becomes user.text when includeUserText is set (session replay)", () => {
    const events = translateSdkMessage(
      userMessage([{ type: "text", text: "What flows exist?" }]),
      TURN,
      { includeUserText: true },
    );
    expect(events).toEqual([
      { kind: "user.text", turnId: TURN, text: "What flows exist?" },
    ]);
  });

  test("includeUserText still extracts tool_result blocks alongside a text block", () => {
    const events = translateSdkMessage(
      userMessage([
        { type: "text", text: "hi" },
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [{ type: "text", text: "ok" }],
        },
      ]),
      TURN,
      { includeUserText: true },
    );
    expect(events).toEqual([
      { kind: "user.text", turnId: TURN, text: "hi" },
      {
        kind: "tool.finished",
        turnId: TURN,
        toolCallId: "call-1",
        ok: true,
        summary: "ok",
        error: undefined,
      },
    ]);
  });

  test("successful result becomes turn.done with cost/duration", () => {
    const msg = {
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      duration_api_ms: 1000,
      is_error: false,
      num_turns: 2,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.05,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: UUID,
      session_id: "session-1",
    } as unknown as SDKMessage;
    expect(translateSdkMessage(msg, TURN)).toEqual([
      {
        kind: "turn.done",
        turnId: TURN,
        ok: true,
        costUsd: 0.05,
        durationMs: 1234,
      },
    ]);
  });

  test("error_max_turns result becomes turn.error with reason max_turns", () => {
    const msg = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 1000,
      duration_api_ms: 900,
      is_error: true,
      num_turns: 10,
      stop_reason: null,
      total_cost_usd: 0.1,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ["hit max turns"],
      uuid: UUID,
      session_id: "session-1",
    } as unknown as SDKMessage;
    expect(translateSdkMessage(msg, TURN)).toEqual([
      {
        kind: "turn.error",
        turnId: TURN,
        reason: "max_turns",
        message: "hit max turns",
      },
    ]);
  });

  test("other error subtypes become turn.error with reason other", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ["boom"],
      uuid: UUID,
      session_id: "session-1",
    } as unknown as SDKMessage;
    expect(translateSdkMessage(msg, TURN)).toEqual([
      { kind: "turn.error", turnId: TURN, reason: "other", message: "boom" },
    ]);
  });

  test("system/init messages are consumed silently (no ChatEvent)", () => {
    const msg = {
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
      session_id: "session-1",
    } as unknown as SDKMessage;
    expect(translateSdkMessage(msg, TURN)).toEqual([]);
  });
});
