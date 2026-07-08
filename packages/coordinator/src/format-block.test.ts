import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatWithBiome } from "./format-block";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

describe("formatWithBiome", () => {
  test("formats valid TypeScript against the repo's own biome.json", async () => {
    const messy =
      'import {defineBlock} from "flowbun"\n' +
      "export default defineBlock({name:'x',config:{},inputs:{},outputs:{},async process(){return}})\n";
    const formatted = await formatWithBiome(
      messy,
      "data/blocks/x.ts",
      REPO_ROOT,
    );
    expect(formatted).not.toBe(messy);
    expect(formatted).toContain('import { defineBlock } from "flowbun";');
    expect(formatted).toContain('name: "x"');
  });

  test("falls back to the raw source on syntactically invalid input", async () => {
    const broken = "import { defineBlock from ;;;\nexport default {{{\n";
    const result = await formatWithBiome(
      broken,
      "data/blocks/broken.ts",
      REPO_ROOT,
    );
    expect(result).toBe(broken);
  });

  test("falls back to the raw source when the repo root is wrong (biome missing)", async () => {
    const source = "const x=1\n";
    const result = await formatWithBiome(source, "x.ts", "/nonexistent-root");
    expect(result).toBe(source);
  });
});
