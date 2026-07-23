import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowEntry } from "flowbun/ws";
import { createGitSnapshotter } from "../git-snapshot";
import { UndoStack } from "../undo-stack";
import {
  type AgentToolDeps,
  blockCreateHandler,
  blockDeleteHandler,
  blockReadHandler,
  blockWriteHandler,
  flowCreateHandler,
  flowDeleteHandler,
  flowReadHandler,
  hassCallServiceHandler,
  hassEntitiesHandler,
  hassGetStateHandler,
  listBlocksHandler,
  listFlowsHandler,
  wiringMutateHandler,
} from "./tools";

let dir: string;
let deps: AgentToolDeps;
let reloadWiringCalls: Array<{ path: string; label?: string }>;
let reloadBlocksCalls: Array<string | undefined>;
let reloadWiringResult: { ok: boolean; output: string };
let reloadBlocksResult: { ok: boolean; output: string };

const TEST_WIRING_FILE = "test_flow.json";
const TEST_BLOCK_FILE = "sample_block.ts";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-agent-tools-test-"));
  mkdirSync(join(dir, "wiring"));
  mkdirSync(join(dir, "blocks"));

  const testWiring = {
    name: "test_flow",
    nodes: { a: { block: "debounce", config: {} } },
    wires: [],
  };
  writeFileSync(
    join(dir, "wiring", TEST_WIRING_FILE),
    JSON.stringify(testWiring, null, 2),
  );
  writeFileSync(
    join(dir, "blocks", TEST_BLOCK_FILE),
    "export default { name: 'sample' };\n",
  );

  const flows = new Map<string, FlowEntry>();
  flows.set(TEST_WIRING_FILE, {
    file: TEST_WIRING_FILE,
    wiring: testWiring,
    status: { kind: "running", pid: 1, since: 0 },
    undo: { canUndo: false, canRedo: false },
  });

  reloadWiringCalls = [];
  reloadBlocksCalls = [];
  reloadWiringResult = { ok: true, output: "" };
  reloadBlocksResult = { ok: true, output: "" };

  const snapshotter = createGitSnapshotter(dir);
  deps = {
    dataDir: dir,
    repoRoot: dir, // deliberately no real biome.json here — formatWithBiome falls back to raw source
    flows,
    undoStack: new UndoStack(snapshotter),
    getPalette: () => [
      {
        name: "debounce",
        file: "debounce.ts",
        inputs: {},
        outputs: {},
        defaultConfig: {},
      },
    ],
    reloadWiringFile: async (path, label) => {
      reloadWiringCalls.push({ path, label });
      return reloadWiringResult;
    },
    reloadBlocksAndRestartAll: async (label) => {
      reloadBlocksCalls.push(label);
      return reloadBlocksResult;
    },
    createFlow: async (name) => ({
      file: `${name}.json`,
      wiring: { name, nodes: {}, wires: [] },
    }),
    createBlock: async (name) => ({
      file: `${name}.ts`,
      source: "export default {};\n",
    }),
    deleteBlock: async () => {},
    deleteFlow: async () => {},
    listHassEntities: async () => [{ id: "light.kitchen" }],
    queryHassState: async (entity) =>
      entity === "light.kitchen"
        ? {
            ok: true,
            reading: {
              entity: "light.kitchen",
              state: "on",
              attributes: { brightness: 128 },
            },
          }
        : { ok: true, reading: undefined },
    callHassService: async () => ({ ok: true }),
    isDryRun: () => false,
    markSelfWrite: () => {},
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wiringMutateHandler", () => {
  test("applies a mutation, writes the file, reloads with an agent-labeled commit message, and records undo", async () => {
    const result = await wiringMutateHandler(deps, {
      file: TEST_WIRING_FILE,
      mutation: { op: "node.position", nodeId: "a", position: { x: 1, y: 2 } },
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("a");

    const written = JSON.parse(
      readFileSync(join(dir, "wiring", TEST_WIRING_FILE), "utf8"),
    );
    expect(written.nodes.a.position).toEqual({ x: 1, y: 2 });

    expect(reloadWiringCalls).toHaveLength(1);
    expect(reloadWiringCalls[0]?.label).toMatch(/^agent: /);
  });

  test("fails cleanly for an unknown wiring file, without writing anything", async () => {
    const result = await wiringMutateHandler(deps, {
      file: "does_not_exist.json",
      mutation: { op: "node.position", nodeId: "a", position: { x: 1, y: 2 } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown wiring file");
    expect(reloadWiringCalls).toHaveLength(0);
  });

  test("surfaces a failed typecheck as ok:false with the typecheck output as the error", async () => {
    reloadWiringResult = { ok: false, output: "type error: whatever" };
    const result = await wiringMutateHandler(deps, {
      file: TEST_WIRING_FILE,
      mutation: { op: "node.position", nodeId: "a", position: { x: 5, y: 5 } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("type error: whatever");
  });
});

describe("blockWriteHandler", () => {
  test("writes the file and reloads with an agent-labeled commit message", async () => {
    const result = await blockWriteHandler(deps, {
      file: TEST_BLOCK_FILE,
      source: "export default { name: 'sample-v2' };\n",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "blocks", TEST_BLOCK_FILE), "utf8")).toBe(
      "export default { name: 'sample-v2' };\n",
    );
    expect(reloadBlocksCalls).toHaveLength(1);
    expect(reloadBlocksCalls[0]).toMatch(/^agent: /);
  });

  test("rejects an unsafe filename without ever writing or reloading", async () => {
    const result = await blockWriteHandler(deps, {
      file: "../escape.ts",
      source: "whatever",
    });
    expect(result.ok).toBe(false);
    expect(reloadBlocksCalls).toHaveLength(0);
  });
});

describe("create/delete delegation", () => {
  test("blockCreateHandler delegates to deps.createBlock", async () => {
    const result = await blockCreateHandler(deps, { name: "My Block" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("My Block.ts");
  });

  test("blockDeleteHandler surfaces a thrown error as ok:false", async () => {
    deps.deleteBlock = async () => {
      throw new Error("still in use");
    };
    const result = await blockDeleteHandler(deps, { file: "foo.ts" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("still in use");
  });

  test("flowCreateHandler delegates to deps.createFlow", async () => {
    const result = await flowCreateHandler(deps, { name: "New Flow" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("New Flow.json");
  });

  test("flowDeleteHandler delegates to deps.deleteFlow", async () => {
    const result = await flowDeleteHandler(deps, { file: TEST_WIRING_FILE });
    expect(result.ok).toBe(true);
  });
});

describe("read-only tools", () => {
  test("flowReadHandler returns the flow's wiring JSON", async () => {
    const result = await flowReadHandler(deps, { file: TEST_WIRING_FILE });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.summary).name).toBe("test_flow");
  });

  test("flowReadHandler fails cleanly for an unknown file", async () => {
    const result = await flowReadHandler(deps, { file: "nope.json" });
    expect(result.ok).toBe(false);
  });

  test("listFlowsHandler summarizes every known flow", async () => {
    const result = await listFlowsHandler(deps);
    const parsed = JSON.parse(result.summary);
    expect(parsed).toEqual([
      {
        file: TEST_WIRING_FILE,
        name: "test_flow",
        nodeCount: 1,
        wireCount: 0,
        status: "running",
      },
    ]);
  });

  test("listBlocksHandler returns the palette", async () => {
    const result = await listBlocksHandler(deps);
    expect(JSON.parse(result.summary)).toEqual(deps.getPalette());
  });

  test("blockReadHandler returns raw source", async () => {
    const result = await blockReadHandler(deps, { file: TEST_BLOCK_FILE });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("export default { name: 'sample' };\n");
  });

  test("blockReadHandler rejects an unsafe filename", async () => {
    const result = await blockReadHandler(deps, { file: "../../etc/passwd" });
    expect(result.ok).toBe(false);
  });

  test("blockReadHandler fails cleanly for a missing file", async () => {
    const result = await blockReadHandler(deps, { file: "missing.ts" });
    expect(result.ok).toBe(false);
  });

  test("hassEntitiesHandler returns the entity list", async () => {
    const result = await hassEntitiesHandler(deps);
    expect(JSON.parse(result.summary)).toEqual([{ id: "light.kitchen" }]);
  });

  test("hassGetStateHandler returns a known entity's reading", async () => {
    const result = await hassGetStateHandler(deps, {
      entity: "light.kitchen",
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.summary)).toEqual({
      entity: "light.kitchen",
      state: "on",
      attributes: { brightness: 128 },
    });
  });

  test("hassGetStateHandler distinguishes an unknown entity from a transport failure", async () => {
    const unknown = await hassGetStateHandler(deps, { entity: "light.nope" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown entity");

    deps.queryHassState = async () => ({ ok: false, error: "no flow-host" });
    const transport = await hassGetStateHandler(deps, {
      entity: "light.kitchen",
    });
    expect(transport.ok).toBe(false);
    expect(transport.error).toBe("no flow-host");
  });
});

describe("hassCallServiceHandler", () => {
  test("builds the ActionCall and reports a live call plainly", async () => {
    const calls: unknown[] = [];
    deps.callHassService = async (call) => {
      calls.push(call);
      return { ok: true };
    };
    const result = await hassCallServiceHandler(deps, {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
      data: { brightness_pct: 40 },
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Called light.turn_on");
    expect(calls).toEqual([
      {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
        data: { brightness_pct: 40 },
      },
    ]);
  });

  test("a dry-run deployment is called out loudly in the summary", async () => {
    deps.isDryRun = () => true;
    const result = await hassCallServiceHandler(deps, {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("DRY-RUN");
    expect(result.summary).toContain("NOT actually executed");
  });

  test("missing domain/service and transport failures both surface as errors", async () => {
    const missing = await hassCallServiceHandler(deps, {
      domain: "",
      service: "turn_on",
    });
    expect(missing.ok).toBe(false);

    deps.callHassService = async () => ({
      ok: false,
      error: "no running flow-host",
    });
    const failed = await hassCallServiceHandler(deps, {
      domain: "light",
      service: "turn_on",
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("no running flow-host");
  });
});
