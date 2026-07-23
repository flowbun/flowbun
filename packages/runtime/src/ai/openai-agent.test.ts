import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Logger, StateScope } from "../block";
import { setHassCallTransport } from "../hass/action";
import { setHassReadTransport } from "../hass/client";
import { setExposedEntitiesTransport } from "../hass/exposed-entities";
import { resetExposedEntitiesCache } from "./hass-tools";
import type { OpenAiAgentConfig } from "./openai-agent";
import { runOpenAiAgent } from "./openai-agent";
import { listTimers, startTimer } from "./voice-timers";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// hass/client.ts's isDryRun() caches Bun.env.FLOWBUN_DRY_RUN on its FIRST
// call, process-wide, and no other test file in the suite ever calls the
// real (non-faked) isDryRun() — so setting this here, before the
// hass_call_service tool test below makes the first real call, is safe and
// deterministic regardless of file execution order. Restored after this
// file's tests in case that ever changes.
const savedDryRunEnv = Bun.env.FLOWBUN_DRY_RUN;
Bun.env.FLOWBUN_DRY_RUN = "false";
afterAll(() => {
  if (savedDryRunEnv === undefined) delete Bun.env.FLOWBUN_DRY_RUN;
  else Bun.env.FLOWBUN_DRY_RUN = savedDryRunEnv;
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setHassReadTransport(null);
  setHassCallTransport(null);
  setExposedEntitiesTransport(null);
  resetExposedEntitiesCache();
});

function config(overrides: Partial<OpenAiAgentConfig> = {}): OpenAiAgentConfig {
  return {
    baseUrl: "http://192.168.1.100:8080/v1",
    model: "qwen3-30b-a3b",
    apiKey: "",
    systemPrompt: "",
    maxTurns: 4,
    maxTokens: 512,
    temperature: 0.7,
    timeoutMs: 5000,
    enableHassTools: false,
    enableTimerTools: false,
    extraBody: {},
    ...overrides,
  };
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successMessage(content: string) {
  return chatResponse({
    choices: [{ message: { role: "assistant", content } }],
  });
}

describe("runOpenAiAgent", () => {
  test("throws immediately when baseUrl is unconfigured", async () => {
    await expect(
      runOpenAiAgent(config({ baseUrl: "" }), "hi", noopLog),
    ).rejects.toThrow('"baseUrl" is not configured');
  });

  test("posts to <baseUrl>/chat/completions with system+user messages, no tools by default", async () => {
    const calls: Array<{
      url: string;
      body: unknown;
      headers: Record<string, string>;
    }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      return successMessage("hi there");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ systemPrompt: "be terse" }),
      "hello",
      noopLog,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://192.168.1.100:8080/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({
      model: "qwen3-30b-a3b",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
    });
    expect((calls[0]?.body as { tools?: unknown }).tools).toBeUndefined();
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(result).toEqual({
      text: "hi there",
      costUsd: 0,
      durationMs: expect.any(Number),
      numTurns: 1,
    });
  });

  test("merges extraBody into the request body, overriding standard fields", async () => {
    let seenBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return successMessage("ok");
    }) as unknown as typeof fetch;

    await runOpenAiAgent(
      config({
        extraBody: {
          chat_template_kwargs: { enable_thinking: false },
          temperature: 0.1,
        },
      }),
      "hi",
      noopLog,
    );

    expect(seenBody?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seenBody?.temperature).toBe(0.1);
  });

  test("includes a bearer Authorization header only when apiKey is set", async () => {
    let seenAuth: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization") ?? undefined;
      return successMessage("ok");
    }) as unknown as typeof fetch;
    await runOpenAiAgent(config({ apiKey: "s3cret" }), "hi", noopLog);
    expect(seenAuth).toBe("Bearer s3cret");
  });

  test("a {prompt, meta} input sends only the prompt and echoes meta on the result", async () => {
    let sentUserContent = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sentUserContent = body.messages.at(-1).content;
      return successMessage("done");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config(),
      {
        prompt: "turn on the lights",
        meta: { requestId: "r-1", conversationId: "c-1" },
      },
      noopLog,
    );

    expect(sentUserContent).toBe("turn on the lights");
    expect(result.meta).toEqual({ requestId: "r-1", conversationId: "c-1" });
  });

  test("a non-2xx response throws with the status and body", async () => {
    globalThis.fetch = (async () =>
      new Response("model not loaded", {
        status: 503,
      })) as unknown as typeof fetch;
    await expect(runOpenAiAgent(config(), "hi", noopLog)).rejects.toThrow(
      /503/,
    );
  });

  test("a response with no choices throws", async () => {
    globalThis.fetch = (async () =>
      chatResponse({ choices: [] })) as unknown as typeof fetch;
    await expect(runOpenAiAgent(config(), "hi", noopLog)).rejects.toThrow(
      "returned no choices",
    );
  });

  test("tool_calls in the response are ignored entirely when enableHassTools is false", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return chatResponse({
        choices: [
          {
            message: {
              content: "here you go",
              tool_calls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "hass_get_state", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableHassTools: false }),
      "hi",
      noopLog,
    );
    expect(calls).toBe(1);
    expect(result.text).toBe("here you go");
    expect(result.numTurns).toBe(1);
  });

  test("tool_calls are executed against the real HA transports and fed back for a second completion", async () => {
    setHassReadTransport({
      readEntity: async (entity) => ({
        entity,
        state: "on",
        attributes: { friendly_name: "Kitchen" },
      }),
    });
    const requestBodies: unknown[] = [];
    let turn = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string));
      turn++;
      if (turn === 1) {
        return chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "hass_get_state",
                      arguments: JSON.stringify({ entity: "light.kitchen" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return successMessage("the kitchen light is on");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableHassTools: true }),
      "is the kitchen light on?",
      noopLog,
    );

    expect(result.text).toBe("the kitchen light is on");
    expect(result.numTurns).toBe(2);
    // second request carries the assistant's tool_calls message and the tool
    // result message appended, proving the loop actually threads them through
    const secondRequestMessages = requestBodies[1] as { messages: unknown[] };
    expect(secondRequestMessages.messages).toHaveLength(3); // user, assistant(tool_calls), tool
    const toolMessage = secondRequestMessages.messages.at(-1) as {
      role: string;
      content: string;
    };
    expect(toolMessage.role).toBe("tool");
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      entity: "light.kitchen",
      state: "on",
    });
  });

  test("hass_call_service tool respects FLOWBUN_DRY_RUN via the real call transport", async () => {
    const executed: unknown[] = [];
    setHassCallTransport({
      call: async (call) => {
        executed.push(call);
      },
    });
    setExposedEntitiesTransport({
      list: async () => [
        {
          entity: "light.kitchen",
          domain: "light",
          friendlyName: "Kitchen",
          aliases: [],
          areaId: null,
        },
      ],
    });
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "hass_call_service",
                      arguments: JSON.stringify({
                        domain: "light",
                        service: "turn_on",
                        entity_id: "light.kitchen",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return successMessage("done");
    }) as unknown as typeof fetch;

    await runOpenAiAgent(
      config({ enableHassTools: true }),
      "turn on the kitchen light",
      noopLog,
    );
    expect(executed).toEqual([
      {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
      },
    ]);
  });

  test("hass_call_service refuses an entity outside the exposed set, without touching the call transport", async () => {
    const executed: unknown[] = [];
    setHassCallTransport({
      call: async (call) => {
        executed.push(call);
      },
    });
    // A definitively-fetched, non-empty exposure list that does NOT contain
    // the target — the one case the exposure check is allowed to block on.
    setExposedEntitiesTransport({
      list: async () => [
        {
          entity: "light.kitchen",
          domain: "light",
          friendlyName: "Kitchen",
          aliases: [],
          areaId: null,
        },
      ],
    });
    let turn = 0;
    let toolResultContent = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "hass_call_service",
                      arguments: JSON.stringify({
                        domain: "lock",
                        service: "unlock",
                        entity_id: "lock.front_door",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      const body = JSON.parse(init.body as string);
      toolResultContent = body.messages.at(-1).content;
      return successMessage("sorry, I can't do that");
    }) as unknown as typeof fetch;

    await runOpenAiAgent(
      config({ enableHassTools: true }),
      "unlock the front door",
      noopLog,
    );

    expect(executed).toEqual([]);
    expect(JSON.parse(toolResultContent)).toMatchObject({ ok: false });
    expect(JSON.parse(toolResultContent).error).toContain("not exposed");
  });

  test("hass_list_entities tool relays through the exposed-entities transport", async () => {
    setExposedEntitiesTransport({
      list: async () => [
        {
          entity: "light.kitchen",
          domain: "light",
          friendlyName: "Kitchen",
          aliases: [],
          areaId: null,
        },
      ],
    });
    let turn = 0;
    let toolResultContent = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "hass_list_entities", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }
      const body = JSON.parse(init.body as string);
      toolResultContent = body.messages.at(-1).content;
      return successMessage("done");
    }) as unknown as typeof fetch;

    await runOpenAiAgent(
      config({ enableHassTools: true }),
      "what can you control?",
      noopLog,
    );
    expect(JSON.parse(toolResultContent)).toEqual([
      {
        entity: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen",
        aliases: [],
        areaId: null,
      },
    ]);
  });

  test("an unrecognized tool name resolves as a tool-level error, not a thrown exception", async () => {
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "delete_everything", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }
      return successMessage("i can't do that");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableHassTools: true }),
      "hi",
      noopLog,
    );
    expect(result.text).toBe("i can't do that");
  });

  test("a model that keeps calling tools forever is stopped at maxTurns", async () => {
    let calls = 0;
    setHassReadTransport({ readEntity: async () => undefined });
    globalThis.fetch = (async () => {
      calls++;
      return chatResponse({
        choices: [
          {
            message: {
              content: "still working on it",
              tool_calls: [
                {
                  id: `call_${calls}`,
                  type: "function",
                  function: {
                    name: "hass_get_state",
                    arguments: JSON.stringify({ entity: "sensor.x" }),
                  },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableHassTools: true, maxTurns: 2 }),
      "hi",
      noopLog,
    );
    expect(calls).toBe(2);
    expect(result.numTurns).toBe(2);
    expect(result.text).toBe("still working on it");
  });

  test("a hung server is aborted at timeoutMs rather than hanging forever", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;

    await expect(
      runOpenAiAgent(config({ timeoutMs: 20 }), "hi", noopLog),
    ).rejects.toThrow();
  });
});

/**
 * The timer tools: same fake-fetch pattern as the HA tool tests above, but
 * asserting against the real voice-timers store (a fake StateScope passed
 * via hooks) — proving a model's tool_calls genuinely create/cancel/query
 * timers in flow state, deviceId included.
 */
describe("runOpenAiAgent timer tools", () => {
  function fakeStateScope(): StateScope {
    const store = new Map<string, unknown>();
    return {
      async get<T>(key: string) {
        return store.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    };
  }

  function toolCallResponse(name: string, args: unknown): Response {
    return chatResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
  }

  test("start_timer stores a timer in flow state, stamped with the meta's deviceId", async () => {
    const flowState = fakeStateScope();
    let turn = 0;
    let toolResult = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) {
        return toolCallResponse("start_timer", { minutes: 10, name: "pasta" });
      }
      const body = JSON.parse(init.body as string);
      toolResult = body.messages.at(-1).content;
      return successMessage("Pasta timer set for 10 minutes.");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableTimerTools: true }),
      {
        prompt: "set a 10 minute pasta timer",
        meta: { requestId: "r-1", conversationId: "c-1", deviceId: "dev-9" },
      },
      noopLog,
      { flowState },
    );

    expect(result.text).toBe("Pasta timer set for 10 minutes.");
    expect(JSON.parse(toolResult)).toMatchObject({
      ok: true,
      timer: { id: 1, name: "pasta" },
    });
    const stored = await listTimers(flowState);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.deviceId).toBe("dev-9");
  });

  test("cancel_timer and timer_status round-trip against the same store", async () => {
    const flowState = fakeStateScope();
    await startTimer(flowState, { minutes: 5, name: "tea" });
    await startTimer(flowState, { minutes: 20 });

    let turn = 0;
    let toolResult = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) return toolCallResponse("cancel_timer", { name: "tea" });
      if (turn === 2) {
        const body = JSON.parse(init.body as string);
        toolResult = body.messages.at(-1).content;
        return toolCallResponse("timer_status", {});
      }
      const body = JSON.parse(init.body as string);
      toolResult = body.messages.at(-1).content;
      return successMessage("done");
    }) as unknown as typeof fetch;

    await runOpenAiAgent(
      config({ enableTimerTools: true }),
      "cancel the tea timer, then how long is left?",
      noopLog,
      { flowState },
    );

    const status = JSON.parse(toolResult);
    expect(status.ok).toBe(true);
    expect(status.timers).toHaveLength(1);
    expect(status.timers[0].id).toBe(2);
    expect(await listTimers(flowState)).toHaveLength(1);
  });

  test("timer tools resolve as errors when enableTimerTools is off, even if the model calls them", async () => {
    const flowState = fakeStateScope();
    let turn = 0;
    let toolResult = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) return toolCallResponse("start_timer", { minutes: 5 });
      const body = JSON.parse(init.body as string);
      toolResult = body.messages.at(-1).content;
      return successMessage("sorry, no timers");
    }) as unknown as typeof fetch;

    // enableHassTools on (so the loop follows tool calls at all), timer off.
    await runOpenAiAgent(
      config({ enableHassTools: true, enableTimerTools: false }),
      "set a timer",
      noopLog,
      { flowState },
    );
    expect(JSON.parse(toolResult).error).toContain("unknown tool");
    expect(await listTimers(flowState)).toHaveLength(0);
  });

  test("a missing flowState surfaces as a tool-level error, not a crash", async () => {
    let turn = 0;
    let toolResult = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      turn++;
      if (turn === 1) return toolCallResponse("start_timer", { minutes: 5 });
      const body = JSON.parse(init.body as string);
      toolResult = body.messages.at(-1).content;
      return successMessage("timers unavailable");
    }) as unknown as typeof fetch;

    const result = await runOpenAiAgent(
      config({ enableTimerTools: true }),
      "set a timer",
      noopLog,
      // no hooks at all
    );
    expect(result.text).toBe("timers unavailable");
    expect(JSON.parse(toolResult).error).toContain("flow state");
  });
});
