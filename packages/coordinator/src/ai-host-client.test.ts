import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "flowbun/ai/agent";
import type { AiHostToCoordinator, CoordinatorToAiHost } from "flowbun/ipc";
import type { FlowEntry } from "flowbun/ws";
import type { AgentToolDeps } from "./agent/tools";
import { createAiHostClient } from "./ai-host-client";
import { ChatEventBuffer } from "./chat-event-buffer";

function fakeDeps(): AgentToolDeps {
  return {
    dataDir: "/tmp/does-not-matter",
    repoRoot: "/tmp/does-not-matter",
    flows: new Map<string, FlowEntry>(),
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by these tests
    undoStack: {} as any,
    getPalette: () => [],
    reloadWiringFile: async () => ({ ok: true, output: "" }),
    reloadBlocksAndRestartAll: async () => ({ ok: true, output: "" }),
    createFlow: async () => {
      throw new Error("not exercised in this test");
    },
    createBlock: async () => {
      throw new Error("not exercised in this test");
    },
    deleteBlock: async () => {},
    deleteFlow: async () => {},
    listHassEntities: async () => [],
    queryHassState: async () => ({ ok: true, reading: undefined }),
    callHassService: async () => ({ ok: true }),
    isDryRun: () => true,
    markSelfWrite: () => {},
  };
}

function fakeAgentConfig(): AgentConfig {
  return {
    systemPrompt: "be helpful",
    model: "",
    fullAccess: false,
    maxTurns: 6,
    timeoutMs: 30_000,
    persistSession: false,
  };
}

function setup() {
  const sent: CoordinatorToAiHost[] = [];
  let onMessage: ((msg: AiHostToCoordinator) => void) | undefined;
  const chatEvents = new ChatEventBuffer();
  const deps = fakeDeps();
  const client = createAiHostClient({
    dataDir: "/tmp/does-not-matter",
    deps,
    chatEvents,
    spawn: (_dataDir, cb) => {
      onMessage = cb;
      return { send: (msg) => sent.push(msg) };
    },
  });
  return {
    client,
    sent,
    chatEvents,
    deps,
    deliver: (msg: AiHostToCoordinator) => onMessage?.(msg),
  };
}

describe("createAiHostClient", () => {
  test("isBusy mirrors the ai-host's chat.busyChanged messages", () => {
    const { client, deliver } = setup();
    expect(client.isBusy()).toBe(false);
    deliver({ type: "chat.busyChanged", busy: true });
    expect(client.isBusy()).toBe(true);
    deliver({ type: "chat.busyChanged", busy: false });
    expect(client.isBusy()).toBe(false);
  });

  test("chat.event messages are pushed into the ChatEventBuffer", () => {
    const { chatEvents, deliver } = setup();
    deliver({
      type: "chat.event",
      event: { kind: "turn.started", turnId: "t1", at: 1 },
    });
    expect(chatEvents.all()).toHaveLength(1);
    expect(chatEvents.all()[0]).toMatchObject({ kind: "turn.started" });
  });

  test("sendChat is fire-and-forget — sends chat.send without waiting for a reply", () => {
    const { client, sent } = setup();
    client.sendChat("hello", "turn-1", "hallway_lights.json");
    expect(sent).toEqual([
      {
        type: "chat.send",
        text: "hello",
        turnId: "turn-1",
        currentFlow: "hallway_lights.json",
      },
    ]);
  });

  test("newChatSession round-trips through chat.newSessionResult", async () => {
    const { client, sent, deliver } = setup();
    const promise = client.newChatSession();
    const req = sent[0];
    if (req?.type !== "chat.newSession")
      throw new Error("expected chat.newSession");
    deliver({
      type: "chat.newSessionResult",
      requestId: req.requestId,
      ok: true,
    });
    await expect(promise).resolves.toEqual({ ok: true, error: undefined });
  });

  test("listChatSessions round-trips through chat.sessionsResult", async () => {
    const { client, sent, deliver } = setup();
    const promise = client.listChatSessions();
    const req = sent[0];
    if (req?.type !== "chat.listSessions")
      throw new Error("expected chat.listSessions");
    deliver({
      type: "chat.sessionsResult",
      requestId: req.requestId,
      ok: true,
      sessions: [{ id: "s1", title: "hi", startedAt: 1, lastUsedAt: 2 }],
    });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessions).toHaveLength(1);
  });

  test("resumeChatSession round-trips through chat.resumeSessionResult", async () => {
    const { client, sent, deliver } = setup();
    const promise = client.resumeChatSession("s1");
    const req = sent[0];
    if (req?.type !== "chat.resumeSession")
      throw new Error("expected chat.resumeSession");
    expect(req.sessionId).toBe("s1");
    deliver({
      type: "chat.resumeSessionResult",
      requestId: req.requestId,
      ok: true,
      events: [],
    });
    await expect(promise).resolves.toEqual({
      ok: true,
      error: undefined,
      events: [],
    });
  });

  test("callAgent round-trips through agent.result and carries flowName/nodeId/config", async () => {
    const { client, sent, deliver } = setup();
    const config = fakeAgentConfig();
    const promise = client.callAgent("flow1", "n1", "hi", config);
    const req = sent[0];
    if (req?.type !== "agent.call") throw new Error("expected agent.call");
    expect(req.flowName).toBe("flow1");
    expect(req.nodeId).toBe("n1");
    expect(req.config).toEqual(config);
    deliver({
      type: "agent.result",
      requestId: req.requestId,
      ok: true,
      text: "done",
      costUsd: 0.01,
      durationMs: 50,
      numTurns: 1,
    });
    await expect(promise).resolves.toEqual({
      ok: true,
      text: "done",
      costUsd: 0.01,
      durationMs: 50,
      numTurns: 1,
    });
  });

  test("cancelForFlow relays agent.cancelForFlow with the given flow name", () => {
    const { client, sent } = setup();
    client.cancelForFlow("flow1");
    expect(sent).toEqual([{ type: "agent.cancelForFlow", flowName: "flow1" }]);
  });

  test("tool.call is dispatched against the real deps and replied with tool.result", async () => {
    const { sent, deliver, deps } = setup();
    deps.listHassEntities = async () => [{ id: "sun.sun" }];
    deliver({
      type: "tool.call",
      requestId: 7,
      tool: "hass_entities",
      args: {},
    });
    // dispatchToolCall's handler is async — give it a tick to resolve and
    // reply before asserting.
    await new Promise((r) => setTimeout(r, 0));
    const reply = sent.find(
      (m) => m.type === "tool.result" && m.requestId === 7,
    );
    if (reply?.type !== "tool.result") throw new Error("expected tool.result");
    expect(reply.result.ok).toBe(true);
    expect(reply.result.summary).toContain("sun.sun");
  });

  test("stop() sends a shutdown message", () => {
    const { client, sent } = setup();
    client.stop();
    expect(sent).toEqual([{ type: "shutdown" }]);
  });
});
