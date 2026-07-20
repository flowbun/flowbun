import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedFlow } from "../router/types";
import { runTypecheck } from "./run";

/**
 * Exercises the real generator + real `tsc` (same pattern spikes/
 * s4-typecheck-latency proved out, and the same function the coordinator
 * and demo runner call for real) rather than unit-testing
 * generateWireAssertions()'s string output — the whole point of both the
 * config-excess-property check and FiringInputs is that they're enforced by
 * the compiler, so the only real test is "does tsc actually reject this."
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixtureFlow(
  blockSource: string,
  config: unknown,
): { dataDir: string; flow: LoadedFlow } {
  const dataDir = mkdtempSync(join(tmpdir(), "flowbun-typecheck-test-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "blocks"), { recursive: true });
  writeFileSync(join(dataDir, "blocks", "fixture.ts"), blockSource);

  const flow: LoadedFlow = {
    name: "test",
    nodes: new Map([
      [
        "n1",
        {
          nodeId: "n1",
          // Not read by generateWireAssertions/runTypecheck — the generated
          // file's own `import Nn from blockSpecifier` is what tsc actually
          // type-checks against, not this in-memory object.
          // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
          block: {} as any,
          blockSpecifier: "../blocks/fixture",
          blockModulePath: join(dataDir, "blocks", "fixture.ts"),
          config,
          // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
          blockState: {} as any,
          disabled: false,
        },
      ],
    ]),
    wireIndex: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    flowState: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by this test
    globalState: {} as any,
  };
  return { dataDir, flow };
}

const CONFIG_FIXTURE_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "fixture",
  config: { count: 5, label: "x" },
  inputs: { in: {} as { at: number } },
  outputs: {},
  async process() { return undefined; },
});
`;

describe("generateWireAssertions: config validation", () => {
  test("a config that only overrides known, correctly-typed keys passes", async () => {
    const { dataDir, flow } = makeFixtureFlow(CONFIG_FIXTURE_BLOCK, {
      count: 10,
    });
    const result = await runTypecheck([flow], dataDir);
    expect(result.ok).toBe(true);
  });

  test("a typo'd config key fails the gate", async () => {
    const { dataDir, flow } = makeFixtureFlow(CONFIG_FIXTURE_BLOCK, {
      cnt: 10,
    });
    const result = await runTypecheck([flow], dataDir);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("cnt");
  });

  test("a wrong-typed config value fails the gate", async () => {
    const { dataDir, flow } = makeFixtureFlow(CONFIG_FIXTURE_BLOCK, {
      count: "ten",
    });
    const result = await runTypecheck([flow], dataDir);
    expect(result.ok).toBe(false);
  });
});

const TWO_INPUT_UNNARROWED_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "two-input-unnarrowed",
  config: {},
  inputs: { a: {} as { x: number }, b: {} as { y: number } },
  outputs: {},
  async process({ a, b }, ctx) {
    const sum = a.x + b.y;
    return undefined;
  },
});
`;

const TWO_INPUT_NARROWED_BLOCK = `
import { defineBlock } from "flowbun";
export default defineBlock({
  name: "two-input-narrowed",
  config: {},
  inputs: { a: {} as { x: number }, b: {} as { y: number } },
  outputs: {},
  async process(inputs, ctx) {
    if (inputs.a !== undefined) {
      const x = inputs.a.x;
      return undefined;
    }
    if (inputs.b !== undefined) {
      const y = inputs.b.y;
      return undefined;
    }
    return undefined;
  },
});
`;

describe("FiringInputs: multi-input narrowing", () => {
  test("a multi-input block that reads an unfired port without narrowing fails the gate", async () => {
    const { dataDir, flow } = makeFixtureFlow(TWO_INPUT_UNNARROWED_BLOCK, {});
    const result = await runTypecheck([flow], dataDir);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("possibly 'undefined'");
  });

  test("a multi-input block that narrows on the actual port value passes", async () => {
    const { dataDir, flow } = makeFixtureFlow(TWO_INPUT_NARROWED_BLOCK, {});
    const result = await runTypecheck([flow], dataDir);
    expect(result.ok).toBe(true);
  });
});
