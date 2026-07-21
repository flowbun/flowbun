import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "flowbun/ai/agent";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { AgentCallResult, AiHostClient } from "./ai-host-client";
import { LogBuffer } from "./log-buffer";
import { Supervisor } from "./supervisor";

function fakeAgentConfig(): AgentConfig {
  return {
    systemPrompt: "be helpful",
    model: "",
    fullAccess: false,
    maxTurns: 6,
    timeoutMs: 30_000,
  };
}

function fakeAiHostClient(callAgentResult: AgentCallResult): AiHostClient & {
  calls: Array<[string, string, unknown, AgentConfig]>;
  cancelled: string[];
} {
  const calls: Array<[string, string, unknown, AgentConfig]> = [];
  const cancelled: string[] = [];
  return {
    calls,
    cancelled,
    isBusy: () => false,
    sendChat: () => {},
    newChatSession: async () => ({ ok: true }),
    listChatSessions: async () => ({ ok: true, sessions: [] }),
    resumeChatSession: async () => ({ ok: true }),
    callAgent: async (flowName, nodeId, input, config) => {
      calls.push([flowName, nodeId, input, config]);
      return callAgentResult;
    },
    cancelForFlow: (flowName) => {
      cancelled.push(flowName);
    },
    stop: () => {},
  };
}

/** onMessage() is private — reaching it directly (rather than driving it
 * through a real spawned flow-host subprocess) mirrors
 * distributed-executor.test.ts's own use of `as any` to construct minimal
 * test doubles for a boundary this codebase doesn't otherwise mock. */
function callOnMessage(
  supervisor: Supervisor,
  rt: { flowName: string },
  msg: FlowHostToCoordinator,
  subprocess: { send: (m: CoordinatorToFlowHost) => void },
): void {
  // biome-ignore lint/suspicious/noExplicitAny: reaching a private method deliberately, see doc comment above
  (supervisor as any).onMessage(rt, msg, subprocess);
}

describe("Supervisor agent.call dispatch", () => {
  test("relays a flow-host's agent.call to aiHostClient.callAgent with the flow name, and replies with agent.result on success", async () => {
    const aiHostClient = fakeAiHostClient({
      ok: true,
      text: "the answer",
      costUsd: 0.01,
      durationMs: 100,
      numTurns: 1,
    });
    const supervisor = new Supervisor(
      "/tmp/does-not-matter",
      new LogBuffer(),
      aiHostClient,
    );

    const sent: CoordinatorToFlowHost[] = [];
    const config = fakeAgentConfig();
    callOnMessage(
      supervisor,
      { flowName: "hallway_lights" },
      { type: "agent.call", requestId: 5, nodeId: "n1", input: "hi", config },
      { send: (m) => sent.push(m) },
    );

    expect(aiHostClient.calls).toEqual([
      ["hallway_lights", "n1", "hi", config],
    ]);

    // callAgent's fake resolves asynchronously (it's declared async) — give
    // the microtask queue a tick before asserting the reply was sent.
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      {
        type: "agent.result",
        requestId: 5,
        ok: true,
        text: "the answer",
        costUsd: 0.01,
        durationMs: 100,
        numTurns: 1,
      },
    ]);
  });

  test("relays a failed agent call as an agent.result with ok:false", async () => {
    const aiHostClient = fakeAiHostClient({
      ok: false,
      error: "Claude isn't set up yet",
    });
    const supervisor = new Supervisor(
      "/tmp/does-not-matter",
      new LogBuffer(),
      aiHostClient,
    );

    const sent: CoordinatorToFlowHost[] = [];
    callOnMessage(
      supervisor,
      { flowName: "hallway_lights" },
      {
        type: "agent.call",
        requestId: 9,
        nodeId: "n1",
        input: "hi",
        config: fakeAgentConfig(),
      },
      { send: (m) => sent.push(m) },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      {
        type: "agent.result",
        requestId: 9,
        ok: false,
        error: "Claude isn't set up yet",
      },
    ]);
  });
});

describe("Supervisor node.dead handling", () => {
  /** registerInactive() creates a real FlowRuntime in the supervisor's own
   * `flows` map (no subprocess spawned) so callOnMessage's mutations land
   * somewhere getStatus() can actually observe them -- unlike the tests
   * above, which only ever inspect the `sent` side channel, this needs the
   * real rt reference, not a disconnected `{flowName}` literal. */
  function registerRunningFlow(
    supervisor: Supervisor,
    flowName: string,
  ): { flowName: string } {
    supervisor.registerInactive(`/tmp/${flowName}.json`, flowName, {
      kind: "running",
      pid: 123,
      since: 1000,
    });
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private `flows` map deliberately, see callOnMessage's own doc comment
    return (supervisor as any).flows.get(flowName);
  }

  test("degrades a running flow's status, folding in every dead node id reported so far", () => {
    const supervisor = new Supervisor(
      "/tmp/does-not-matter",
      new LogBuffer(),
      fakeAiHostClient({
        ok: true,
        text: "",
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
      }),
    );
    const rt = registerRunningFlow(supervisor, "hallway_lights");

    callOnMessage(
      supervisor,
      rt,
      { type: "node.dead", nodeId: "n1" },
      { send: () => {} },
    );
    expect(supervisor.getStatus("hallway_lights")).toEqual({
      kind: "degraded",
      pid: 123,
      since: 1000,
      reason: "node(s) permanently dead (respawn limit exceeded): n1",
    });

    callOnMessage(
      supervisor,
      rt,
      { type: "node.dead", nodeId: "n2" },
      { send: () => {} },
    );
    expect(supervisor.getStatus("hallway_lights")).toEqual({
      kind: "degraded",
      pid: 123,
      since: 1000,
      reason: "node(s) permanently dead (respawn limit exceeded): n1, n2",
    });
  });

  test("leaves a non-running/degraded flow's status alone -- there's no pid/since to attach a degraded status to", () => {
    const supervisor = new Supervisor(
      "/tmp/does-not-matter",
      new LogBuffer(),
      fakeAiHostClient({
        ok: true,
        text: "",
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
      }),
    );
    supervisor.registerInactive("/tmp/hallway_lights.json", "hallway_lights", {
      kind: "restarting",
      attempt: 1,
      nextAttemptAt: 5000,
    });
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private `flows` map deliberately, see callOnMessage's own doc comment
    const rt = (supervisor as any).flows.get("hallway_lights");
    const before = supervisor.getStatus("hallway_lights");

    callOnMessage(
      supervisor,
      rt,
      { type: "node.dead", nodeId: "n1" },
      { send: () => {} },
    );

    expect(supervisor.getStatus("hallway_lights")).toEqual(before);
  });
});
