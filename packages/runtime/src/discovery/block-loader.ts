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

export class BlockDiscoveryError extends Error {}

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
    const mod = await import(absPath);
    if (!isBlockDef(mod)) {
      throw new BlockDiscoveryError(
        `${absPath} does not have a valid defineBlock default export`,
      );
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
