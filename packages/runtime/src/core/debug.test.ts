import { describe, expect, test } from "bun:test";
import type { BlockContext, Logger } from "../block";
import debugBlock, { serializeForDebug } from "./debug";

describe("serializeForDebug", () => {
  test("serializes plain objects as compact JSON", () => {
    expect(serializeForDebug({ foo: 1, bar: "baz" })).toBe(
      '{"foo":1,"bar":"baz"}',
    );
  });

  test("serializes primitives", () => {
    expect(serializeForDebug(42)).toBe("42");
    expect(serializeForDebug("hi")).toBe('"hi"');
    expect(serializeForDebug(null)).toBe("null");
    expect(serializeForDebug(true)).toBe("true");
  });

  test("undefined becomes the literal string, not JSON.stringify's own undefined value", () => {
    expect(serializeForDebug(undefined)).toBe("undefined");
  });

  test("circular references don't throw — they surface as a readable marker", () => {
    // biome-ignore lint/suspicious/noExplicitAny: constructing a circular structure on purpose
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(serializeForDebug(circular)).toContain("<unserializable:");
  });

  test("bigint doesn't throw — it also surfaces as a readable marker", () => {
    expect(serializeForDebug({ n: 10n })).toContain("<unserializable:");
  });
});

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
