import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionId, writeSessionId } from "./session-store";

let dir: string;
let sessionFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-session-store-test-"));
  sessionFile = join(dir, "session.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session-store", () => {
  test("readSessionId returns undefined when no file exists yet", () => {
    expect(readSessionId(sessionFile)).toBeUndefined();
  });

  test("writeSessionId then readSessionId round-trips", () => {
    writeSessionId(sessionFile, "abc-123");
    expect(readSessionId(sessionFile)).toBe("abc-123");
  });

  test("writeSessionId overwrites a previous value", () => {
    writeSessionId(sessionFile, "first");
    writeSessionId(sessionFile, "second");
    expect(readSessionId(sessionFile)).toBe("second");
  });

  test("readSessionId fails open (returns undefined) on corrupt JSON", () => {
    writeFileSync(sessionFile, "{ not valid json");
    expect(readSessionId(sessionFile)).toBeUndefined();
  });
});
