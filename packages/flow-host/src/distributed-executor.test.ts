import { describe, expect, test } from "bun:test";
import type { LoadedFlow, LoadedNode, Logger } from "flowbun";
import type { AgentConfig } from "flowbun/ai/agent";
import type { FlowHostToCoordinator } from "flowbun/ipc";
import { DistributedExecutor } from "./distributed-executor";
import type { WorkerManager } from "./worker-manager";

function fakeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: "be helpful",
    model: "",
    fullAccess: false,
    maxTurns: 6,
    timeoutMs: 20,
    ...overrides,
  };
}

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeNode(blockName: string, config: unknown = {}): LoadedNode {
  return {
    nodeId: "n1",
    block: {
      name: blockName,
      config: {},
      inputs: {},
      outputs: {},
      process: async () => undefined,
    },
    blockSpecifier: blockName,
    blockModulePath: blockName,
    config,
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by these tests
    blockState: {} as any,
    disabled: false,
  };
}

function fakeFlow(node: LoadedNode): LoadedFlow {
  return {
    name: "test",
    nodes: new Map([[node.nodeId, node]]),
    wireIndex: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by these tests
    flowState: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by these tests
    globalState: {} as any,
  };
}

describe("DistributedExecutor agent calls", () => {
  test("callAgent resolves normally when the coordinator replies before the timeout", async () => {
    const sent: FlowHostToCoordinator[] = [];
    const config = fakeAgentConfig();
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("@ai/agent", config)),
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      workerManager: {} as any as WorkerManager,
      send: (msg) => sent.push(msg),
      log: noopLog,
      agentCallTimeoutMarginMs: 0,
    });

    const promise = executor.execute({
      nodeId: "n1",
      inputs: { prompt: "summarize the flow" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });

    const call = sent[0];
    if (call?.type !== "agent.call") throw new Error("expected agent.call");
    expect(call.config).toEqual(config);
    expect(call.input).toBe("summarize the flow");
    executor.handleAgentResult({
      type: "agent.result",
      requestId: call.requestId,
      ok: true,
      text: "the flow does X",
      costUsd: 0.02,
      durationMs: 1200,
      numTurns: 2,
    });

    await expect(promise).resolves.toEqual({
      result: {
        text: "the flow does X",
        costUsd: 0.02,
        durationMs: 1200,
        numTurns: 2,
      },
    });
  });

  test("callAgent rejects with a timeout error if the coordinator never replies, and doesn't hang the caller", async () => {
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("@ai/agent", fakeAgentConfig())),
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      workerManager: {} as any as WorkerManager,
      send: () => {}, // simulates the coordinator/ai-host hanging forever — no reply ever sent
      log: noopLog,
      agentCallTimeoutMarginMs: 0,
    });

    const promise = executor.execute({
      nodeId: "n1",
      inputs: { prompt: "hi" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });

    await expect(promise).rejects.toThrow(/timed out/);
  });

  test("a late agent.result arriving after the timeout is a safe no-op", async () => {
    const sent: FlowHostToCoordinator[] = [];
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("@ai/agent", fakeAgentConfig())),
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      workerManager: {} as any as WorkerManager,
      send: (msg) => sent.push(msg),
      log: noopLog,
      agentCallTimeoutMarginMs: 0,
    });

    const promise = executor.execute({
      nodeId: "n1",
      inputs: { prompt: "hi" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });
    await expect(promise).rejects.toThrow(/timed out/);

    const call = sent[0];
    if (call?.type !== "agent.call") throw new Error("expected agent.call");
    // Arrives well after the timeout already rejected — must not throw.
    expect(() =>
      executor.handleAgentResult({
        type: "agent.result",
        requestId: call.requestId,
        ok: true,
        text: "too late",
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
      }),
    ).not.toThrow();
  });

  test("callAgent rejects with the coordinator's own error message on ok:false", async () => {
    const sent: FlowHostToCoordinator[] = [];
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("@ai/agent", fakeAgentConfig())),
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      workerManager: {} as any as WorkerManager,
      send: (msg) => sent.push(msg),
      log: noopLog,
      agentCallTimeoutMarginMs: 0,
    });

    const promise = executor.execute({
      nodeId: "n1",
      inputs: { prompt: "hi" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });

    const call = sent[0];
    if (call?.type !== "agent.call") throw new Error("expected agent.call");
    executor.handleAgentResult({
      type: "agent.result",
      requestId: call.requestId,
      ok: false,
      error: "Claude isn't set up yet",
    });

    await expect(promise).rejects.toThrow(/Claude isn't set up yet/);
  });

  test("the IPC-level timeout is the node's own timeoutMs plus the configured margin", async () => {
    const config = fakeAgentConfig({ timeoutMs: 20 });
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("@ai/agent", config)),
      // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      workerManager: {} as any as WorkerManager,
      send: () => {},
      log: noopLog,
      agentCallTimeoutMarginMs: 15,
    });

    const start = Date.now();
    const promise = executor.execute({
      nodeId: "n1",
      inputs: { prompt: "hi" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });
    await expect(promise).rejects.toThrow(/timed out after 35ms/);
    // Sanity: actually waited roughly timeoutMs+margin, not just the bare
    // node timeout — guards against the margin silently being dropped.
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});
