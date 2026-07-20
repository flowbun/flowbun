import { describe, expect, test } from "bun:test";
import { serializeForDebug } from "./debug";

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
