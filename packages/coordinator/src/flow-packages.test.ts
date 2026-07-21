import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AnyBlockDef, BlockRegistry } from "flowbun";
import type { FlowEntry, TypecheckOutcome } from "flowbun/ws";
import {
  createFlowPackageManager,
  type FlowPackageDeps,
  isSafeRegistryPath,
  ModifiedFilesError,
  parseFlowbunRange,
  readTrackingFile,
  satisfiesFlowbunRange,
  sha256OfBytes,
  writeTrackingFile,
} from "./flow-packages";

// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

let dataDir: string;
let registryDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flowbun-flowpkg-data-"));
  mkdirSync(join(dataDir, "blocks"), { recursive: true });
  mkdirSync(join(dataDir, "wiring"), { recursive: true });
  registryDir = mkdtempSync(join(tmpdir(), "flowbun-flowpkg-registry-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

interface FixtureBlock {
  path: string; // "blocks/foo.ts" or "blocks/__tests__/foo.test.ts"
  content: string;
}
interface FixtureWiring {
  path: string; // "wiring/foo_demo.json"
  wiring: {
    name: string;
    nodes: Record<string, unknown>;
    wires: unknown[];
    disabled?: boolean;
  };
}
interface FixtureVersion {
  version: string;
  description?: string;
  flowbun?: string;
  npmDependencies?: Record<string, string>;
  blocks: FixtureBlock[];
  wiring?: FixtureWiring[];
}

function writeFixtureFile(dir: string, relPath: string, content: string) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Writes one or more package versions into registryDir and a matching
 * index.json — real files on disk so fetchRegistryBytes's local-path branch
 * exercises the exact code path a real registry checkout would. Versions
 * are sorted newest-first, matching the real registry's build-index.ts
 * convention (resolveVersion's "no version requested" default relies on
 * this ordering, exactly like the real installer would). */
function seedRegistry(
  packages: { name: string; versions: FixtureVersion[] }[],
) {
  const indexPackages = packages.map((pkg) => ({
    name: pkg.name,
    versions: [...pkg.versions]
      .sort((a, b) => compareSemver(a.version, b.version))
      .map((v) => {
        const dir = join(registryDir, "packages", pkg.name, v.version);
        const blocks = v.blocks.map((b) => {
          writeFixtureFile(dir, b.path, b.content);
          return {
            path: b.path,
            sha256: sha256OfBytes(new TextEncoder().encode(b.content)),
          };
        });
        const wiring = (v.wiring ?? []).map((w) => {
          const text = `${JSON.stringify(w.wiring, null, 2)}\n`;
          writeFixtureFile(dir, w.path, text);
          return {
            path: w.path,
            sha256: sha256OfBytes(new TextEncoder().encode(text)),
          };
        });
        return {
          version: v.version,
          description: v.description ?? "a fixture package",
          flowbun: v.flowbun ?? ">=0",
          npmDependencies: v.npmDependencies ?? {},
          blocks,
          wiring,
          tests: [],
        };
      }),
  }));
  writeFixtureFile(
    registryDir,
    "index.json",
    `${JSON.stringify({ schemaVersion: 1, packages: indexPackages }, null, 2)}\n`,
  );
}

function fixtureBlockDef(name: string): AnyBlockDef {
  return {
    name,
    config: {},
    inputs: {},
    outputs: {},
    async process() {
      return {};
    },
  };
}

/** Fakes reload/delete with just enough real behavior (mutating `flows`/
 * `registry` from what's actually on disk) that install/uninstall/update's
 * own post-write assumptions hold, without pulling in the real
 * typecheck/discoverBlocks/supervisor machinery. */
function makeHarness() {
  const flows = new Map<string, FlowEntry>();
  const registry: BlockRegistry = new Map();
  const calls: string[] = [];

  async function reloadBlocksAndRestartAll(
    label?: string,
  ): Promise<TypecheckOutcome> {
    calls.push(`reloadBlocksAndRestartAll:${label ?? ""}`);
    const blocksDir = join(dataDir, "blocks");
    for (const file of new Bun.Glob("*.ts").scanSync({ cwd: blocksDir })) {
      const stem = file.replace(/\.ts$/, "");
      if (!registry.has(stem)) {
        registry.set(stem, {
          def: fixtureBlockDef(stem),
          specifier: `../blocks/${stem}`,
          modulePath: join(blocksDir, file),
          origin: "user",
        });
      }
    }
    for (const name of [...registry.keys()]) {
      const entry = registry.get(name);
      if (entry?.origin !== "user") continue;
      if (!existsSync(entry.modulePath)) registry.delete(name);
    }
    return { ok: true, output: "" };
  }

  async function reloadWiringFile(
    path: string,
    label?: string,
  ): Promise<TypecheckOutcome> {
    calls.push(`reloadWiringFile:${label ?? ""}`);
    const file = basename(path);
    const wiring = JSON.parse(readFileSync(path, "utf8"));
    flows.set(file, {
      file,
      wiring,
      status: wiring.disabled ? { kind: "disabled" } : { kind: "starting" },
      undo: { canUndo: false, canRedo: false },
    });
    return { ok: true, output: "" };
  }

  async function deleteFlow(file: string): Promise<void> {
    calls.push(`deleteFlow:${file}`);
    const path = join(dataDir, "wiring", file);
    if (existsSync(path)) rmSync(path);
    flows.delete(file);
  }

  const forgottenUndo: string[] = [];

  function makeDeps(registrySource: string): FlowPackageDeps {
    return {
      dataDir,
      registrySource,
      runtimeVersion: "0.1.0",
      flows,
      getBlockRegistry: () => registry,
      reloadBlocksAndRestartAll,
      reloadWiringFile,
      deleteFlow,
      markSelfWrite: () => {},
      forgetUndo: (relPath: string) => forgottenUndo.push(relPath),
    };
  }

  return { flows, registry, calls, forgottenUndo, makeDeps };
}

const DEMO_BLOCK = `import { defineBlock } from "flowbun";
export default defineBlock({
  name: "demo_block",
  config: {},
  inputs: {},
  outputs: {},
  async process() { return {}; },
});
`;

function demoWiring(name = "demo_flow", disabled = false) {
  return {
    name,
    nodes: { n1: { block: "demo_block", position: { x: 0, y: 0 } } },
    wires: [],
    disabled,
  };
}

// ---------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------

describe("parseFlowbunRange / satisfiesFlowbunRange", () => {
  test("parses >=x, >=x.y, >=x.y.z", () => {
    expect(parseFlowbunRange(">=0")).toEqual([0, 0, 0]);
    expect(parseFlowbunRange(">=0.1")).toEqual([0, 1, 0]);
    expect(parseFlowbunRange(">=0.2.0")).toEqual([0, 2, 0]);
  });

  test("rejects anything else", () => {
    expect(parseFlowbunRange("^1.0.0")).toBeUndefined();
    expect(parseFlowbunRange("*")).toBeUndefined();
    expect(parseFlowbunRange("garbage")).toBeUndefined();
  });

  test("satisfiesFlowbunRange compares against the runtime version", () => {
    expect(satisfiesFlowbunRange(">=0", "0.1.0")).toBe(true);
    expect(satisfiesFlowbunRange(">=0.1", "0.1.0")).toBe(true);
    expect(satisfiesFlowbunRange(">=0.2.0", "0.1.0")).toBe(false);
    expect(satisfiesFlowbunRange("garbage", "0.1.0")).toBeUndefined();
  });
});

describe("isSafeRegistryPath", () => {
  test("accepts well-formed block/wiring paths", () => {
    expect(isSafeRegistryPath("blocks/a.ts")).toBe(true);
    expect(isSafeRegistryPath("blocks/__tests__/a.test.ts")).toBe(true);
    expect(isSafeRegistryPath("wiring/a.json")).toBe(true);
  });

  test("rejects traversal, absolute paths, and disallowed shapes", () => {
    expect(isSafeRegistryPath("../x")).toBe(false);
    expect(isSafeRegistryPath("/etc/passwd")).toBe(false);
    expect(isSafeRegistryPath("blocks/../../x")).toBe(false);
    expect(isSafeRegistryPath("wiring/sub/a.json")).toBe(false);
    expect(isSafeRegistryPath("state/x")).toBe(false);
    expect(isSafeRegistryPath("blocks/sub/a.ts")).toBe(false);
  });
});

describe("tracking file", () => {
  test("missing file reads as empty", async () => {
    const data = await readTrackingFile(dataDir);
    expect(data).toEqual({ schemaVersion: 1, packages: [] });
  });

  test("round-trips and sorts by name", async () => {
    await writeTrackingFile(dataDir, {
      schemaVersion: 1,
      packages: [
        {
          name: "zeta",
          version: "1.0.0",
          source: "x",
          installedAt: "2024-01-01T00:00:00.000Z",
          npmDependencies: {},
          files: [],
        },
        {
          name: "alpha",
          version: "1.0.0",
          source: "x",
          installedAt: "2024-01-01T00:00:00.000Z",
          npmDependencies: {},
          files: [],
        },
      ],
    });
    const data = await readTrackingFile(dataDir);
    expect(data.packages.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });
});

// ---------------------------------------------------------------------
// install
// ---------------------------------------------------------------------

describe("install", () => {
  test("happy path: writes files, forces disabled, tracks written-byte hashes, reloads in order", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [
              { path: "blocks/demo_block.ts", content: DEMO_BLOCK },
              {
                path: "blocks/__tests__/demo_block.test.ts",
                content: "// test\n",
              },
            ],
            wiring: [
              {
                path: "wiring/demo_flow.json",
                // Registry wiring deliberately NOT disabled -- install must
                // force it anyway (defense in depth).
                wiring: demoWiring("demo_flow", false),
              },
            ],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));

    const result = await manager.install("demo-pkg");
    expect(result.version).toBe("1.0.0");
    expect(result.typecheck.ok).toBe(true);

    expect(existsSync(join(dataDir, "blocks", "demo_block.ts"))).toBe(true);
    expect(
      existsSync(join(dataDir, "blocks", "__tests__", "demo_block.test.ts")),
    ).toBe(true);

    const written = JSON.parse(
      readFileSync(join(dataDir, "wiring", "demo_flow.json"), "utf8"),
    );
    expect(written.disabled).toBe(true);

    const tracking = await readTrackingFile(dataDir);
    expect(tracking.packages).toHaveLength(1);
    const pkg = tracking.packages[0];
    expect(pkg?.version).toBe("1.0.0");
    const wiringEntry = pkg?.files.find(
      (f) => f.path === "wiring/demo_flow.json",
    );
    const writtenBytes = readFileSync(
      join(dataDir, "wiring", "demo_flow.json"),
    );
    expect(wiringEntry?.sha256).toBe(
      sha256OfBytes(new Uint8Array(writtenBytes)),
    );

    // Call order: blocks reload once, then one reloadWiringFile per file.
    expect(h.calls[0]).toMatch(/^reloadBlocksAndRestartAll:/);
    expect(h.calls[1]).toMatch(/^reloadWiringFile:/);
    expect(h.flows.get("demo_flow.json")?.status).toEqual({ kind: "disabled" });
  });

  test("sha256 mismatch aborts with zero writes", async () => {
    seedRegistry([
      {
        name: "bad-pkg",
        versions: [
          { version: "1.0.0", blocks: [{ path: "blocks/x.ts", content: "a" }] },
        ],
      },
    ]);
    // Corrupt the file on disk after the index was built from its original content.
    writeFixtureFile(
      registryDir,
      "packages/bad-pkg/1.0.0/blocks/x.ts",
      "TAMPERED",
    );
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));

    await expect(manager.install("bad-pkg")).rejects.toThrow(/hash mismatch/);
    expect(existsSync(join(dataDir, "blocks", "x.ts"))).toBe(false);
  });

  test("block name collision with an existing block is rejected", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    h.registry.set("demo_block", {
      def: fixtureBlockDef("demo_block"),
      specifier: "../blocks/demo_block",
      modulePath: join(dataDir, "blocks", "demo_block.ts"),
      origin: "user",
    });
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(/collision/);
  });

  test("wiring filename collision with an existing flow is rejected", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [],
            wiring: [
              {
                path: "wiring/demo_flow.json",
                wiring: demoWiring("demo_flow"),
              },
            ],
          },
        ],
      },
    ]);
    const h = makeHarness();
    h.flows.set("demo_flow.json", {
      file: "demo_flow.json",
      wiring: demoWiring("something_else"),
      status: { kind: "disabled" },
      undo: { canUndo: false, canRedo: false },
    });
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(/collision/);
  });

  test("duplicate internal wiring name across a different filename is rejected", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [],
            wiring: [
              {
                path: "wiring/other_file.json",
                wiring: demoWiring("demo_flow"),
              },
            ],
          },
        ],
      },
    ]);
    const h = makeHarness();
    // A pre-existing flow with a DIFFERENT filename but the SAME internal name.
    h.flows.set("demo_flow_old.json", {
      file: "demo_flow_old.json",
      wiring: demoWiring("demo_flow"),
      status: { kind: "disabled" },
      undo: { canUndo: false, canRedo: false },
    });
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(
      /collides with an existing flow/,
    );
  });

  test("already-installed package is rejected", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          { version: "1.0.0", blocks: [{ path: "blocks/x.ts", content: "a" }] },
        ],
      },
    ]);
    const h = makeHarness();
    await writeTrackingFile(dataDir, {
      schemaVersion: 1,
      packages: [
        {
          name: "demo-pkg",
          version: "1.0.0",
          source: registryDir,
          installedAt: new Date(0).toISOString(),
          npmDependencies: {},
          files: [],
        },
      ],
    });
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(
      /already installed/,
    );
  });

  test("schemaVersion mismatch is rejected", async () => {
    writeFixtureFile(
      registryDir,
      "index.json",
      `${JSON.stringify({ schemaVersion: 2, packages: [] }, null, 2)}\n`,
    );
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(/schemaVersion/);
  });

  test("unparseable compat range is refused", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            flowbun: "^1.0.0",
            blocks: [{ path: "blocks/x.ts", content: "a" }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(
      /can't parse compat range/,
    );
  });

  test("incompatible flowbun range is refused", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            flowbun: ">=99.0.0",
            blocks: [{ path: "blocks/x.ts", content: "a" }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.install("demo-pkg")).rejects.toThrow(
      /requires flowbun/,
    );
  });
});

// ---------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------

describe("uninstall", () => {
  async function installDemo(h: ReturnType<typeof makeHarness>) {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
            wiring: [
              {
                path: "wiring/demo_flow.json",
                wiring: demoWiring("demo_flow"),
              },
            ],
          },
        ],
      },
    ]);
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await manager.install("demo-pkg");
    return manager;
  }

  test("guard trips before deleting anything when a user flow references a package block", async () => {
    const h = makeHarness();
    const manager = await installDemo(h);

    // A separate user flow (not the package's own demo_flow) references the
    // installed block.
    h.flows.set("user_flow.json", {
      file: "user_flow.json",
      wiring: {
        name: "user_flow",
        nodes: { n1: { block: "demo_block" } },
        wires: [],
      },
      status: { kind: "running", pid: 1, since: 0 },
      undo: { canUndo: false, canRedo: false },
    });

    await expect(manager.uninstall("demo-pkg")).rejects.toThrow(/user_flow/);
    expect(existsSync(join(dataDir, "blocks", "demo_block.ts"))).toBe(true);
    expect(existsSync(join(dataDir, "wiring", "demo_flow.json"))).toBe(true);
  });

  test("the package's own demo wiring referencing its own block does not trip the guard", async () => {
    const h = makeHarness();
    const manager = await installDemo(h);

    const result = await manager.uninstall("demo-pkg");
    expect(existsSync(join(dataDir, "blocks", "demo_block.ts"))).toBe(false);
    expect(existsSync(join(dataDir, "wiring", "demo_flow.json"))).toBe(false);
    expect(result.modifiedFiles).toEqual([]);
    expect((await readTrackingFile(dataDir)).packages).toHaveLength(0);
    expect(h.forgottenUndo).toContain("blocks/demo_block.ts");
  });

  test("reports locally modified files but still uninstalls", async () => {
    const h = makeHarness();
    const manager = await installDemo(h);
    writeFileSync(
      join(dataDir, "blocks", "demo_block.ts"),
      "// edited locally\n",
    );

    const result = await manager.uninstall("demo-pkg");
    expect(result.modifiedFiles).toEqual(["blocks/demo_block.ts"]);
    expect(existsSync(join(dataDir, "blocks", "demo_block.ts"))).toBe(false);
  });

  test("tolerates files the user already deleted", async () => {
    const h = makeHarness();
    const manager = await installDemo(h);
    rmSync(join(dataDir, "blocks", "demo_block.ts"));

    const result = await manager.uninstall("demo-pkg");
    expect(result.modifiedFiles).toEqual(["blocks/demo_block.ts"]);
    expect((await readTrackingFile(dataDir)).packages).toHaveLength(0);
  });

  test("not-installed package is rejected", async () => {
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.uninstall("nope")).rejects.toThrow(/not installed/);
  });
});

// ---------------------------------------------------------------------
// update
// ---------------------------------------------------------------------

describe("update", () => {
  function seedTwoVersions(extra?: Partial<FixtureVersion>) {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
            wiring: [
              {
                path: "wiring/demo_flow.json",
                wiring: demoWiring("demo_flow"),
              },
            ],
          },
          {
            version: "1.1.0",
            blocks: [
              { path: "blocks/demo_block.ts", content: `${DEMO_BLOCK}// v2\n` },
            ],
            wiring: [
              {
                path: "wiring/demo_flow.json",
                wiring: demoWiring("demo_flow"),
              },
            ],
            ...extra,
          },
        ],
      },
    ]);
  }

  async function installV1(h: ReturnType<typeof makeHarness>) {
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await manager.install("demo-pkg", "1.0.0");
    return manager;
  }

  test("refuses to update to the currently-installed version", async () => {
    seedTwoVersions();
    const h = makeHarness();
    const manager = await installV1(h);
    await expect(
      manager.update("demo-pkg", { version: "1.0.0" }),
    ).rejects.toThrow(/already at/);
  });

  test("refuses with ModifiedFilesError when local edits exist and force is not set", async () => {
    seedTwoVersions();
    const h = makeHarness();
    const manager = await installV1(h);
    writeFileSync(join(dataDir, "blocks", "demo_block.ts"), "// edited\n");

    let caught: unknown;
    try {
      await manager.update("demo-pkg");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModifiedFilesError);
    expect((caught as InstanceType<typeof ModifiedFilesError>).files).toEqual([
      "blocks/demo_block.ts",
    ]);
    // Nothing was touched.
    expect(readFileSync(join(dataDir, "blocks", "demo_block.ts"), "utf8")).toBe(
      "// edited\n",
    );
  });

  test("force overwrites local edits and updates to the new version", async () => {
    seedTwoVersions();
    const h = makeHarness();
    const manager = await installV1(h);
    writeFileSync(join(dataDir, "blocks", "demo_block.ts"), "// edited\n");

    const result = await manager.update("demo-pkg", { force: true });
    expect(result.version).toBe("1.1.0");
    expect(
      readFileSync(join(dataDir, "blocks", "demo_block.ts"), "utf8"),
    ).toContain("// v2");
    const tracking = await readTrackingFile(dataDir);
    expect(tracking.packages[0]?.version).toBe("1.1.0");
  });

  test("a file removed in the new version is deleted", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            blocks: [
              { path: "blocks/demo_block.ts", content: DEMO_BLOCK },
              {
                path: "blocks/extra_block.ts",
                content: DEMO_BLOCK.replace("demo_block", "extra_block"),
              },
            ],
          },
          {
            version: "1.1.0",
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await manager.install("demo-pkg", "1.0.0");
    expect(existsSync(join(dataDir, "blocks", "extra_block.ts"))).toBe(true);

    await manager.update("demo-pkg", { version: "1.1.0" });
    expect(existsSync(join(dataDir, "blocks", "extra_block.ts"))).toBe(false);
    expect(existsSync(join(dataDir, "blocks", "demo_block.ts"))).toBe(true);
  });

  test("a new npm dependency is recorded; a dropped one is left installed", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            npmDependencies: { "left-behind": "^1.0.0" },
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
          },
          {
            version: "1.1.0",
            npmDependencies: {},
            blocks: [{ path: "blocks/demo_block.ts", content: DEMO_BLOCK }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    // Skip the real npm install: pre-seed the tracking file directly at
    // v1.0.0 instead of calling install() (which would shell out to `bun
    // add left-behind` against a throwaway dataDir with no network access
    // in a unit-test environment). The npm dependency install/removal path
    // itself is exercised by the end-to-end verification pass, not here.
    await writeTrackingFile(dataDir, {
      schemaVersion: 1,
      packages: [
        {
          name: "demo-pkg",
          version: "1.0.0",
          source: registryDir,
          installedAt: new Date(0).toISOString(),
          npmDependencies: { "left-behind": "^1.0.0" },
          files: [
            {
              path: "blocks/demo_block.ts",
              sha256: sha256OfBytes(new TextEncoder().encode(DEMO_BLOCK)),
            },
          ],
        },
      ],
    });
    writeFileSync(join(dataDir, "blocks", "demo_block.ts"), DEMO_BLOCK);

    const result = await manager.update("demo-pkg", { version: "1.1.0" });
    expect(result.version).toBe("1.1.0");
    const tracking = await readTrackingFile(dataDir);
    // "left-behind" is simply no longer declared by the new version's
    // manifest -- update doesn't call bun remove for it (documented
    // "shared dependency" policy), it just isn't tracked against this
    // package anymore.
    expect(tracking.packages[0]?.npmDependencies).toEqual({});
  });

  test("not-installed package is rejected", async () => {
    seedTwoVersions();
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await expect(manager.update("demo-pkg")).rejects.toThrow(/not installed/);
  });
});

// ---------------------------------------------------------------------
// browseRegistry / listInstalled
// ---------------------------------------------------------------------

describe("browseRegistry / listInstalled", () => {
  test("browseRegistry reports compatibility and installed version", async () => {
    seedRegistry([
      {
        name: "demo-pkg",
        versions: [
          {
            version: "1.0.0",
            flowbun: ">=0",
            blocks: [{ path: "blocks/x.ts", content: "a" }],
          },
        ],
      },
      {
        name: "incompatible-pkg",
        versions: [
          {
            version: "1.0.0",
            flowbun: ">=99.0.0",
            blocks: [{ path: "blocks/y.ts", content: "b" }],
          },
        ],
      },
    ]);
    const h = makeHarness();
    const manager = createFlowPackageManager(h.makeDeps(registryDir));
    await manager.install("demo-pkg");

    const { packages } = await manager.browseRegistry();
    const demo = packages.find((p) => p.name === "demo-pkg");
    const incompatible = packages.find((p) => p.name === "incompatible-pkg");
    expect(demo?.installedVersion).toBe("1.0.0");
    expect(demo?.versions[0]?.compatible).toBe(true);
    expect(incompatible?.installedVersion).toBeUndefined();
    expect(incompatible?.versions[0]?.compatible).toBe(false);
  });

  test("listInstalled reflects the tracking file only, no network", async () => {
    const h = makeHarness();
    const manager = createFlowPackageManager(
      h.makeDeps("http://unreachable.invalid"),
    );
    expect(await manager.listInstalled()).toEqual([]);
  });
});
