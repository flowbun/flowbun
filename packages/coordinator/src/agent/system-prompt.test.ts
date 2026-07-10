import { describe, expect, test } from "bun:test";
import {
  AGENT_SYSTEM_PROMPT_APPEND,
  buildSystemPromptAppend,
} from "./system-prompt";

describe("buildSystemPromptAppend", () => {
  test("with no currentFlow, returns the base append unchanged", () => {
    expect(buildSystemPromptAppend()).toBe(AGENT_SYSTEM_PROMPT_APPEND);
    expect(buildSystemPromptAppend(undefined)).toBe(AGENT_SYSTEM_PROMPT_APPEND);
  });

  test("with a currentFlow, appends a note naming the exact file", () => {
    const result = buildSystemPromptAppend("hallway_lights.json");
    expect(result.startsWith(AGENT_SYSTEM_PROMPT_APPEND)).toBe(true);
    expect(result).toContain('"hallway_lights.json"');
  });
});
