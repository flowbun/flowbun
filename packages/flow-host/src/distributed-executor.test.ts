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
    persistSession: false,
    ...overrides,
  };
}

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeNode(
  blockName: string,
  config: unknown = {},
  kind: "relay" | "transform" = "relay",
): LoadedNode {
  // Built as two distinctly-typed branches rather than one object literal
  // with a variable `kind` — a literal like `"relay"` discriminates the
  // BlockDef union, but a `"relay" | "transform"`-typed *value* in that
  // position doesn't satisfy either member.
  const block =
    kind === "relay"
      ? {
          name: blockName,
          kind: "relay" as const,
          config: {},
          inputs: {},
          outputs: {},
        }
      : {
          name: blockName,
          config: {},
          inputs: {},
          outputs: {},
          // Only needsWorker()/kind checks read this in-memory stub in
          // these tests — process() itself is never actually invoked.
          async process() {
            return undefined;
          },
        };
  return {
    nodeId: "n1",
    block,
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

  test("a {prompt, meta} input sends only the prompt and echoes meta on the result", async () => {
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
      inputs: {
        prompt: {
          prompt: "turn on the lights",
          meta: { requestId: "r-42", conversationId: "c-1" },
        },
      },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });

    const call = sent[0];
    if (call?.type !== "agent.call") throw new Error("expected agent.call");
    // The model sees the bare prompt string — never the correlation state.
    expect(call.input).toBe("turn on the lights");
    executor.handleAgentResult({
      type: "agent.result",
      requestId: call.requestId,
      ok: true,
      text: "done",
      costUsd: 0.01,
      durationMs: 900,
      numTurns: 1,
    });

    await expect(promise).resolves.toEqual({
      result: {
        text: "done",
        costUsd: 0.01,
        durationMs: 900,
        numTurns: 1,
        meta: { requestId: "r-42", conversationId: "c-1" },
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

describe("DistributedExecutor ordinary (non-relay) exec timeout override", () => {
  test("a node whose config has a numeric timeoutMs gets it passed through (plus margin) to WorkerManager.exec", async () => {
    const execCalls: Array<{ nodeId: string; req: unknown }> = [];
    const executor = new DistributedExecutor({
      flow: fakeFlow(
        fakeNode("@ai/openai_agent", { timeoutMs: 12_345 }, "transform"),
      ),
      workerManager: {
        allocRequestId: () => 1,
        exec: async (nodeId: string, _requestId: number, req: unknown) => {
          execCalls.push({ nodeId, req });
          return { result: { text: "ok" } };
        },
        // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      } as any as WorkerManager,
      send: () => {},
      log: noopLog,
    });

    await executor.execute({
      nodeId: "n1",
      inputs: { prompt: "hi" },
      port: "prompt",
      traceId: "t1",
      seq: 1,
    });

    expect(execCalls).toHaveLength(1);
    expect((execCalls[0]?.req as { timeoutMs?: number }).timeoutMs).toBe(
      12_345 + 2_000,
    );
  });

  test("a node whose config has no timeoutMs field gets no override (WorkerManager falls back to its own default)", async () => {
    const execCalls: Array<{ req: unknown }> = [];
    const executor = new DistributedExecutor({
      flow: fakeFlow(fakeNode("debounce", { ms: 30_000 }, "transform")),
      workerManager: {
        allocRequestId: () => 1,
        exec: async (_nodeId: string, _requestId: number, req: unknown) => {
          execCalls.push({ req });
          return { stable: { state: "on" } };
        },
        // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
      } as any as WorkerManager,
      send: () => {},
      log: noopLog,
    });

    await executor.execute({
      nodeId: "n1",
      inputs: { signal: { state: "on", at: 1 } },
      port: "signal",
      traceId: "t1",
      seq: 1,
    });

    expect(
      (execCalls[0]?.req as { timeoutMs?: number }).timeoutMs,
    ).toBeUndefined();
  });
});
