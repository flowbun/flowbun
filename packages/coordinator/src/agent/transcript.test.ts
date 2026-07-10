import { describe, expect, test } from "bun:test";
import { replaySessionTranscript } from "./transcript";

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("replaySessionTranscript", () => {
  test("empty transcript yields no events", () => {
    expect(replaySessionTranscript("")).toEqual([]);
  });

  test("blank lines and unparseable garbage lines are skipped, not thrown", () => {
    const text = `${jsonl([
      {
        type: "user",
        promptId: "p1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ])}\n\nnot json at all\n`;
    const events = replaySessionTranscript(text);
    expect(events.some((e) => e.kind === "user.text")).toBe(true);
  });

  test("CLI-internal bookkeeping record types are dropped entirely", () => {
    const text = jsonl([
      { type: "queue-operation", operation: "enqueue" },
      { type: "ai-title", title: "some title" },
      { type: "last-prompt", lastPrompt: "hi" },
      { type: "mode", mode: "default" },
    ]);
    expect(replaySessionTranscript(text)).toEqual([]);
  });

  test("a real two-turn transcript, with bookkeeping records interleaved, replays as two grouped turns", () => {
    const text = jsonl([
      { type: "queue-operation", operation: "enqueue" },
      {
        type: "user",
        promptId: "p1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      { type: "ai-title", title: "Greeting" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      { type: "last-prompt", lastPrompt: "hi" },
      { type: "mode", mode: "default" },
      {
        type: "user",
        promptId: "p2",
        message: { role: "user", content: [{ type: "text", text: "do X" }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "mcp__flowbun__list_flows",
              input: {},
            },
          ],
        },
      },
      {
        // Same promptId as the turn's opening prompt — a tool_result relay,
        // not a new user prompt (matches real transcripts: only a text
        // block starts a new turn).
        type: "user",
        promptId: "p2",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: "3 flows" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done, did X" }] },
      },
    ]);

    expect(replaySessionTranscript(text)).toEqual([
      { kind: "user.text", turnId: "p1", text: "hi" },
      { kind: "assistant.text", turnId: "p1", text: "hello" },
      { kind: "turn.done", turnId: "p1", ok: true },
      { kind: "user.text", turnId: "p2", text: "do X" },
      {
        kind: "tool.started",
        turnId: "p2",
        toolCallId: "call-1",
        summary: "list_flows",
      },
      {
        kind: "tool.finished",
        turnId: "p2",
        toolCallId: "call-1",
        ok: true,
        summary: "3 flows",
        error: undefined,
      },
      { kind: "assistant.text", turnId: "p2", text: "Done, did X" },
      { kind: "turn.done", turnId: "p2", ok: true },
    ]);
  });

  test("records before any real user text prompt are ignored (nothing to attribute them to)", () => {
    const text = jsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "orphaned" }] },
      },
    ]);
    expect(replaySessionTranscript(text)).toEqual([]);
  });

  test("a single-message turn (just the opening prompt, no reply yet) still closes with turn.done", () => {
    const text = jsonl([
      {
        type: "user",
        promptId: "p1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(replaySessionTranscript(text)).toEqual([
      { kind: "user.text", turnId: "p1", text: "hi" },
      { kind: "turn.done", turnId: "p1", ok: true },
    ]);
  });

  test("a turn that produces zero translatable events (e.g. only a thinking block) gets no synthetic turn.done", () => {
    const text = jsonl([
      {
        type: "queue-operation",
        operation: "enqueue",
      },
    ]);
    // No real user prompt was ever seen, so currentTurnId never gets set —
    // nothing to attribute a turn.done to.
    expect(replaySessionTranscript(text)).toEqual([]);
  });
});
