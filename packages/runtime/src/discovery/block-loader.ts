import { join, relative } from "node:path";
import aiAgent from "../ai/agent";
import type { AnyBlockDef } from "../block";
import coreDebug from "../core/debug";
import coreInject from "../core/inject";
import coreScheduler from "../core/scheduler";
import hassAction from "../hass/action";
import hassRead from "../hass/read";
import hassTrigger from "../hass/trigger";
import type { BlockRegistry } from "../wiring/flow-assembly";

function isBlockDef(
  mod: Record<string, unknown>,
): mod is { default: AnyBlockDef } {
  const def = mod.default as Partial<AnyBlockDef> | undefined;
  return (
    typeof def === "object" &&
    def !== null &&
    typeof def.name === "string" &&
    typeof def.process === "function" &&
    typeof def.inputs === "object" &&
    typeof def.outputs === "object"
  );
}

/** Scans `<dataDir>/blocks/*.ts`, dynamic-importing each and registering the two built-in @hass/* blocks. */
export async function discoverBlocks(dataDir: string): Promise<BlockRegistry> {
  const registry: BlockRegistry = new Map();
  // modulePath is unreachable in practice for these two — the flow-host
  // never spawns a Worker for @hass/* nodes (see DistributedExecutor) — kept
  // populated only for symmetry with user blocks.
  registry.set("@hass/trigger", {
    def: hassTrigger,
    specifier: "flowbun/hass/trigger",
    modulePath: "flowbun/hass/trigger",
  });
  registry.set("@hass/action", {
    def: hassAction,
    specifier: "flowbun/hass/action",
    modulePath: "flowbun/hass/action",
  });
  registry.set("@core/scheduler", {
    def: coreScheduler,
    specifier: "flowbun/core/scheduler",
    modulePath: "flowbun/core/scheduler",
  });
  registry.set("@hass/read", {
    def: hassRead,
    specifier: "flowbun/hass/read",
    modulePath: "flowbun/hass/read",
  });
  registry.set("@core/inject", {
    def: coreInject,
    specifier: "flowbun/core/inject",
    modulePath: "flowbun/core/inject",
  });
  registry.set("@core/debug", {
    def: coreDebug,
    specifier: "flowbun/core/debug",
    modulePath: "flowbun/core/debug",
  });
  registry.set("@ai/agent", {
    def: aiAgent,
    specifier: "flowbun/ai/agent",
    modulePath: "flowbun/ai/agent",
  });

  const blocksDir = join(dataDir, "blocks");
  const generatedDir = join(dataDir, "generated");
  const glob = new Bun.Glob("*.ts");

  for await (const file of glob.scan({ cwd: blocksDir })) {
    const absPath = join(blocksDir, file);
    // Bun's ES module cache is keyed by the resolved specifier string, not
    // file content or mtime -- a bare `import(absPath)` on the *second*
    // discoverBlocks() call for the same path within one coordinator
    // process returns the module object from the first call, silently
    // ignoring whatever's actually on disk now. Every real block file
    // already gets imported once at coordinator startup, so this bit
    // *every* live block-port edit made through the editor after that,
    // not just repeated reloads (e.g. restoreFlow's write-then-validate):
    // assembleFlow kept validating against the stale, startup-time port
    // shape instead of the just-saved one. A cache-busting query string
    // forces a genuinely fresh read+evaluate every call, matching what
    // every caller here already assumes ("the registry reflects what's on
    // disk right now").
    // A syntactically broken block file (a real possibility mid-edit, or a
    // typo saved by mistake) makes `import()` throw -- previously bare and
    // uncaught here, which took discoverBlocks(), and every one of its
    // callers (coordinator startup, every reload path, every flow-host
    // subprocess's own registry build) down with it: one bad block file
    // could crash the entire coordinator process, not just fail to load.
    // Skipping the broken file here instead means any flow that actually
    // references it fails on its own, in the open, via assembleFlow's
    // already-isolated "unknown block" error (see loadAllFlows/
    // reloadBlocksAndRestartAll in coordinator/main.ts) -- a flow that
    // doesn't reference it is completely unaffected, exactly like any
    // other single-flow structural failure.
    let mod: Record<string, unknown>;
    try {
      mod = await import(`${absPath}?t=${Date.now()}`);
    } catch (err) {
      console.error(
        `[discoverBlocks] ${absPath} failed to import, skipping it:\n${err}`,
      );
      continue;
    }
    if (!isBlockDef(mod)) {
      console.error(
        `[discoverBlocks] ${absPath} does not have a valid defineBlock default export, skipping it`,
      );
      continue;
    }
    const relSpecifier = relative(generatedDir, absPath).replace(/\.ts$/, "");
    registry.set(mod.default.name, {
      def: mod.default,
      specifier: relSpecifier.startsWith(".")
        ? relSpecifier
        : `./${relSpecifier}`,
      modulePath: absPath,
    });
  }

  return registry;
}
