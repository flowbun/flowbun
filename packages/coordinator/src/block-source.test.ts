import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractBlockName,
  PUBLIC_IMPORTS,
  renameBlockDefName,
  rewriteRelativeImports,
} from "./block-source";

const RUNTIME_DIR = join(import.meta.dir, "..", "..", "runtime");
const BUILTIN_BLOCKS_DIR = join(RUNTIME_DIR, "src", "blocks");
const CORE_SCHEDULER = join(BUILTIN_BLOCKS_DIR, "core-scheduler.ts");

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

/** Any `"./x"`/`"../x"` still sitting in an import/export-from position.
 * Deliberately a *different*, blunter pattern than the one under test — a
 * test that reuses the implementation's own regex would agree with it about
 * anything it fails to match. */
const REMAINING_RELATIVE = /\bfrom\s*"(\.[^"]*)"/g;

describe("rewriteRelativeImports", () => {
  test("maps ../block onto the package root", () => {
    expect(
      rewriteRelativeImports('import { defineBlock } from "../block";'),
    ).toBe('import { defineBlock } from "flowbun";');
  });

  test("maps a ../<dir>/<mod> specifier onto its flowbun subpath", () => {
    expect(
      rewriteRelativeImports(
        'import { registerScheduler } from "../core/scheduler";',
      ),
    ).toBe('import { registerScheduler } from "flowbun/core/scheduler";');
  });

  test("rewrites type-only imports too", () => {
    expect(
      rewriteRelativeImports(
        'import type { TriggerConfig } from "../hass/trigger";',
      ),
    ).toBe('import type { TriggerConfig } from "flowbun/hass/trigger";');
  });

  test("rewrites the closing line of a multi-line named-import block", () => {
    const source = 'import type {\n  HttpInConfig,\n} from "../http/in";\n';
    expect(rewriteRelativeImports(source)).toBe(
      'import type {\n  HttpInConfig,\n} from "flowbun/http/in";\n',
    );
  });

  test("rewrites re-exports as well as imports", () => {
    expect(
      rewriteRelativeImports('export type { ReadConfig } from "../hass/read";'),
    ).toBe('export type { ReadConfig } from "flowbun/hass/read";');
  });

  test("rewrites a bare side-effect import", () => {
    expect(rewriteRelativeImports('import "../core/debug";')).toBe(
      'import "flowbun/core/debug";',
    );
  });

  test("leaves bare/external specifiers untouched", () => {
    const source = [
      'import { z } from "zod";',
      'import SunCalc from "suncalc";',
      'import type { ENTITY_STATE } from "@digital-alchemy/hass";',
      'import { defineBlock } from "flowbun";',
      "",
    ].join("\n");
    expect(rewriteRelativeImports(source)).toBe(source);
  });

  test("leaves a string that merely looks like an import alone", () => {
    const source = 'const help = `run: import x from "../block"`;\n';
    expect(rewriteRelativeImports(source)).toBe(source);
  });

  test("throws naming both the specifier and the block when there's no public equivalent", () => {
    // "../router/router" is a genuine internal: runtime's `exports` map has
    // no "./router/router" entry, and unlike core/switch or ai/openai-agent
    // there's no reason it should — the router is the flow-host's own
    // machinery, not something a block could meaningfully import. A block
    // reaching for it is exactly the mistake this throw exists to catch.
    const source = [
      'import { defineBlock } from "../block";',
      'import { Router } from "../router/router";',
      "export default defineBlock({",
      '  name: "@ai/openai",',
      "});",
      "",
    ].join("\n");
    expect(() => rewriteRelativeImports(source)).toThrow(
      /\.\.\/router\/router/,
    );
    expect(() => rewriteRelativeImports(source)).toThrow(/@ai\/openai/);
  });
});

/**
 * The whole table is only correct relative to packages/runtime/package.json:
 * a data/blocks/*.ts file resolves `"flowbun/..."` through that `exports`
 * map and nothing else. Without this test, adding a new export subpath (or
 * renaming one) would leave duplicateBlock quietly emitting a specifier that
 * doesn't resolve — which fails in the one way this whole change exists to
 * prevent, i.e. invisibly, at discoverBlocks import time.
 */
describe("PUBLIC_IMPORTS", () => {
  const exportsMap: Record<string, unknown> = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "package.json"), "utf8"),
  ).exports;

  test("covers exactly the two-segment subpaths runtime's package.json exports", () => {
    const exported = Object.keys(exportsMap)
      .filter((key) => /^\.\/[^./]+\/[^./]+$/.test(key))
      .map((key) => key.slice(2))
      .sort();
    const mapped = Object.values(PUBLIC_IMPORTS)
      .filter((value) => value !== "flowbun")
      .map((value) => value.replace(/^flowbun\//, ""))
      .sort();
    expect(mapped).toEqual(exported);
  });

  test("maps each relative specifier onto the matching flowbun subpath", () => {
    for (const [specifier, mapped] of Object.entries(PUBLIC_IMPORTS)) {
      if (specifier === "../block") continue;
      expect(mapped).toBe(`flowbun/${specifier.slice(3)}`);
      // Not toHaveProperty: it reads "." as a key-path separator.
      expect(Object.keys(exportsMap)).toContain(`./${specifier.slice(3)}`);
    }
  });

  test("../block resolves through the package root export", () => {
    expect(PUBLIC_IMPORTS["../block"]).toBe("flowbun");
    expect(exportsMap["."]).toBe("./src/index.ts");
  });
});

/**
 * The set of built-ins that CANNOT be duplicated, asserted explicitly so the
 * set is documented and any change to it is visible in a diff rather than
 * discovered by a user whose duplicate silently vanished.
 *
 * Currently empty, and deliberately kept as a list rather than inlined as
 * `toEqual([])`: this started as three blocks — agent-hass.ts and
 * openai-agent.ts both reached into "../ai/openai-agent", core-switch.ts
 * into "../core/switch", and neither module was in runtime's `exports` map.
 * Both were exported (see packages/runtime/package.json, its mirrored
 * `paths` entry in runtime's typecheck/run.ts, and PUBLIC_IMPORTS) purely so
 * that every built-in can be forked into an editable data/blocks/ copy — the
 * editor's ✎-on-a-built-in action is worth little if it fails for an
 * arbitrary-looking subset. A new built-in that imports a module outside the
 * exports map lands back on this list, and this test is what says so.
 *
 * Note on why this asserts on the rewritten *text* rather than importing the
 * result: TS import elision drops an import whose bindings are unused or
 * type-only, so a rewritten source can import perfectly well while still
 * containing a specifier that would fail the moment somebody used it.
 */
const UNDUPLICABLE_BUILTINS: string[] = [];

describe("rewriteRelativeImports over every real built-in block", () => {
  const files = readdirSync(BUILTIN_BLOCKS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  test("every block either rewrites clean or throws, and the throwing set is exactly the documented one", () => {
    expect(files.length).toBeGreaterThan(5);

    const threw: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(BUILTIN_BLOCKS_DIR, file), "utf8");
      let rewritten: string;
      try {
        rewritten = rewriteRelativeImports(source);
      } catch (err) {
        threw.push(file);
        // The message has to name the offending specifier — it's the only
        // actionable thing in it.
        expect(String(err)).toMatch(/"\.\.\/[^"]+"/);
        continue;
      }
      const leftovers = [...rewritten.matchAll(REMAINING_RELATIVE)].map(
        (m) => m[1],
      );
      expect({ file, leftovers }).toEqual({ file, leftovers: [] });
    }

    expect(threw.sort()).toEqual(UNDUPLICABLE_BUILTINS);
  });
});
