import { describe, expect, test } from "bun:test";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  test("zero and negative are both '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });

  test("sub-1024 stays in bytes, whole numbers", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  test("scales up through KB/MB/GB with one decimal place", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});
