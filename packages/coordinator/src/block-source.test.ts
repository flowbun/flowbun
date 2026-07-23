import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBlockName, renameBlockDefName } from "./block-source";

const CORE_SCHEDULER = join(
  import.meta.dir,
  "..",
  "..",
  "runtime",
  "src",
  "blocks",
  "core-scheduler.ts",
);

describe("extractBlockName", () => {
  test("reads the name field out of a real built-in block", () => {
    const source = readFileSync(CORE_SCHEDULER, "utf8");
    expect(extractBlockName(source)).toBe("@core/scheduler");
  });

  test("unescapes a name containing a quote or backslash", () => {
    expect(extractBlockName('  name: "a \\"quoted\\" \\\\ name",\n')).toBe(
      'a "quoted" \\ name',
    );
  });

  test("returns undefined when there's no name field", () => {
    expect(
      extractBlockName("export default defineBlock({ config: {} })"),
    ).toBeUndefined();
  });
});

describe("renameBlockDefName", () => {
  test("rewrites a real built-in block's name field, leaving everything else untouched", () => {
    const source = readFileSync(CORE_SCHEDULER, "utf8");
    const renamed = renameBlockDefName(
      source,
      "@core/scheduler",
      "@core/scheduler 2",
    );
    expect(extractBlockName(renamed)).toBe("@core/scheduler 2");
    expect(renamed.replace('"@core/scheduler 2"', '"@core/scheduler"')).toBe(
      source,
    );
  });

  test("escapes a new name that itself needs quoting", () => {
    const renamed = renameBlockDefName(
      'export default defineBlock({\n  name: "old",\n});\n',
      "old",
      'new "one"',
    );
    expect(extractBlockName(renamed)).toBe('new "one"');
  });

  test("throws when the name field is missing", () => {
    expect(() =>
      renameBlockDefName(
        "export default defineBlock({ config: {} })",
        "old",
        "new",
      ),
    ).toThrow();
  });

  test("throws when the existing name doesn't match what was expected", () => {
    expect(() =>
      renameBlockDefName('name: "actual",\n', "expected", "new"),
    ).toThrow();
  });
});
