import { describe, expect, test } from "bun:test";
import type { BlockContext, Logger } from "../../block";
import type { SwitchConfig } from "../../core/switch";
import switchBlock from "../core-switch";

describe("@core/switch block", () => {
  function fakeCtx(
    selected: SwitchConfig["selected"],
  ): BlockContext<SwitchConfig> {
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    return {
      config: { selected },
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
      port: "input",
    };
  }

  test("routes to `a` when selected is a", async () => {
    const result = await switchBlock.process(
      { input: { hello: "world" } },
      fakeCtx("a"),
    );
    expect(result).toEqual({ a: { hello: "world" } });
  });

  test("routes to `b` when selected is b", async () => {
    const result = await switchBlock.process(
      { input: { hello: "world" } },
      fakeCtx("b"),
    );
    expect(result).toEqual({ b: { hello: "world" } });
  });

  test("emits nothing when the input port didn't actually fire", async () => {
    const result = await switchBlock.process(
      { input: undefined },
      fakeCtx("a"),
    );
    expect(result).toBeUndefined();
  });

  test("declares the toggle control @core/switch is for", () => {
    expect(switchBlock.control).toEqual({
      kind: "toggle",
      configKey: "selected",
      values: ["a", "b"],
      labels: ["A", "B"],
    });
  });
});
