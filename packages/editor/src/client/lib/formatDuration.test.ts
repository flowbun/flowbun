import { describe, expect, test } from "bun:test";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  test("under a minute shows only seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
  });

  test("minutes drop the seconds entirely", () => {
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(40 * 60)).toBe("40m");
  });

  test("hours include minutes but not seconds", () => {
    expect(formatDuration(2 * 3600 + 15 * 60 + 9)).toBe("2h 15m");
  });

  test("days include hours and minutes", () => {
    expect(formatDuration(3 * 86400 + 2 * 3600 + 5 * 60)).toBe("3d 2h 5m");
  });

  test("negative durations clamp to zero", () => {
    expect(formatDuration(-100)).toBe("0s");
  });
});
