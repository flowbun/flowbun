import { describe, expect, test } from "bun:test";
import type { BlockContext, Logger } from "../../block";
import debugBlock from "../core-debug";

describe("@core/debug block", () => {
  function fakeCtx(): {
    ctx: BlockContext<Record<string, never>>;
    logged: string[];
  } {
    const logged: string[] = [];
    const log: Logger = {
      debug: (msg) => logged.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    return {
      ctx: {
        config: {},
        state: {
          block: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
          },
          flow: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
          },
          global: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
          },
        },
        log,
        traceId: "test",
        seq: 0,
        port: "msg",
      },
      logged,
    };
  }

  test("logs the serialized payload at debug level", async () => {
    const { ctx, logged } = fakeCtx();
    await debugBlock.process({ msg: { hello: "world" } }, ctx);
    expect(logged).toEqual(['{"hello":"world"}']);
  });

  test("has no outputs — it's a sink, not a passthrough", () => {
    expect(Object.keys(debugBlock.outputs)).toEqual([]);
  });
});
