import { describe, expect, test } from "bun:test";
import { configFieldKeys } from "./configFieldKeys";

describe("configFieldKeys", () => {
  test("keeps the default config's declaration order", () => {
    expect(
      configFieldKeys({ mode: "interval", intervalMs: 60_000 }, {}),
    ).toEqual(["mode", "intervalMs"]);
  });

  test("appends keys the node has but the default doesn't — the @core/scheduler union case", () => {
    expect(
      configFieldKeys(
        { mode: "interval", intervalMs: 60_000 },
        { mode: "dailyTime", time: "15:00", weekdays: [2] },
      ),
    ).toEqual(["mode", "intervalMs", "time", "weekdays"]);
  });

  test("de-duplicates keys present in both, without moving them", () => {
    expect(configFieldKeys({ a: 1, b: 2 }, { b: 9, a: 8, c: 7 })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("falls back to the node's own keys when the block declares no default", () => {
    expect(configFieldKeys({}, { x: 1, y: 2 })).toEqual(["x", "y"]);
  });

  test("still renders declared keys the node has dropped entirely", () => {
    expect(configFieldKeys({ a: 1, b: 2 }, { a: 5 })).toEqual(["a", "b"]);
  });

  test("no keys anywhere means no fields", () => {
    expect(configFieldKeys({}, {})).toEqual([]);
  });
});
